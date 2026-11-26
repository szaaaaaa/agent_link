import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { request } from "../dist/daemon/lifecycle.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function until(probe, description, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(30);
  }
  throw new Error("Timed out: " + description);
}

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "al-ah-"));
  const env = { ...process.env, AGENT_LINK_HOME: root, AGENT_LINK_AGY_FIRST_INVOCATION: "0",
    PI_CODING_AGENT_DIR: join(root, "pi"), PI_CODING_AGENT_SESSION_DIR: join(root, "pi", "sessions"),
    CODEX_HOME: join(root, "codex") };
  let daemon;
  const run = (args, input) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { err += chunk; });
    child.stdin.end(input);
    return { child, done: new Promise((resolve) => child.once("close", (code) => resolve({ out, err, code }))) };
  };
  const stop = async () => {
    if (!daemon || daemon.child.exitCode !== null) return;
    await request(root, "daemon-stop");
    assert.equal((await daemon.done).code, 0);
  };
  const start = async () => {
    daemon = run(["daemon", "run"]);
    await until(() => request(root, "daemon-status").catch(() => null), "daemon ready");
  };
  t.after(async () => {
    try { await stop(); } catch { daemon?.child.kill(); if (daemon) await daemon.done; }
    rmSync(root, { recursive: true, force: true, maxRetries: 4 });
  });
  const call = async (event, input) => {
    const result = await run(["hook", event], typeof input === "string" ? input : JSON.stringify(input)).done;
    assert.equal(result.code, 0, result.err);
    return JSON.parse(result.out);
  };
  const sql = (statement, ...params) => {
    const db = new DatabaseSync(join(root, "state.sqlite"), { readOnly: true });
    try { return db.prepare(statement).all(...params); } finally { db.close(); }
  };
  return { root, start, stop, call, sql, watch: (path) => request(root, "watch", path) };
}

const step = (step_index, type, content) => JSON.stringify({ step_index, type, status: "DONE", content }) + "\n";
const user = (i, text) => step(i, "USER_INPUT", `<USER_REQUEST>\n${text}\n</USER_REQUEST>`);
const answer = (i, text) => step(i, "PLANNER_RESPONSE", text);
const history = (reply) => reply.injectSteps?.[0]?.systemMessage.systemMessage ?? "";
const markdown = (reply) => reply.injectSteps?.[0]?.systemMessage.metadata?.user_markdown ?? "";

function window(workspace, id) {
  const path = join(workspace, id, "transcript.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  return { conversationId: id, cwd: workspace, workspacePaths: [join(workspace, "not-watched"), workspace], transcriptPath: path };
}

async function putTurn(box, w, question, i = 0) {
  appendFileSync(w.transcriptPath, user(i, question) + answer(i + 1, "Answer to " + question));
  assert.deepEqual(await box.call("Stop", { ...w, terminationReason: "NO_TOOL_CALL" }), { decision: "stop" });
  return until(() => box.sql(`SELECT t.* FROM threads t JOIN bindings b ON b.thread_id = t.thread_id
    WHERE b.agent = 'antigravity' AND b.native_session_id = ? AND t.head_turn_id IS NOT NULL`, w.conversationId)[0], "ingested turn");
}

test("Hook CLI links explicitly, rejects cross-workspace history, and keeps old conversations separate", async (t) => {
  const box = sandbox(t);
  const a = join(box.root, "work-a"), b = join(box.root, "work-b");
  mkdirSync(a); mkdirSync(b);
  const first = window(a, "first"), next = window(a, "next"), other = window(b, "other");
  await box.start();
  assert.deepEqual(await box.call("SessionStart", first), {});
  assert.deepEqual(await box.call("Stop", "not json"), { decision: "stop" });
  await box.watch(a); await box.watch(b);
  assert.deepEqual(await box.call("PreInvocation", { ...first, lastUserInput: "pure", invocationNum: 0 }), {});
  assert.deepEqual(await box.call("Stop", { ...first, terminationReason: "USER_CANCELED" }), { decision: "stop" });
  assert.equal(box.sql("SELECT * FROM threads").length, 0);
  const aThread = await putTurn(box, first, "A confidential sample");
  const bThread = await putTurn(box, other, "B only");
  const hint = await box.call("SessionStart", next);
  assert.equal(history(hint), "");
  assert.match(markdown(hint), /A confidential sample/);
  assert.doesNotMatch(markdown(hint), /B only/);
  assert.equal(box.sql("SELECT * FROM bindings WHERE native_session_id = 'next'").length, 0);

  const denied = `#link ${aThread.thread_id}`;
  appendFileSync(other.transcriptPath, user(2, denied));
  const reject = await box.call("PreInvocation", { ...other, invocationNum: 0, lastUserInput: denied });
  assert.equal(history(reject), "");
  assert.match(markdown(reject), /没有唯一匹配/);
  assert.equal(box.sql("SELECT thread_id FROM bindings WHERE native_session_id = 'other'")[0].thread_id, bThread.thread_id);

  const former = await putTurn(box, next, "Keep this standalone");
  const link = `#link ${aThread.thread_id.slice(-8)}`;
  appendFileSync(next.transcriptPath, user(2, link));
  assert.deepEqual(await box.call("PreInvocation", { ...next, invocationNum: 1, lastUserInput: link }), {});
  const linked = await box.call("PreInvocation", { ...next, invocationNum: 0, lastUserInput: link });
  assert.match(history(linked), /Answer to A confidential sample/);
  assert.doesNotMatch(history(linked), /Keep this standalone|B only/);
  assert.deepEqual(await box.call("PreInvocation", { ...next, invocationNum: 0, lastUserInput: link }), {});
  assert.equal(box.sql("SELECT thread_id FROM bindings WHERE native_session_id = 'next'")[0].thread_id, aThread.thread_id);
  assert.equal(box.sql("SELECT * FROM turns WHERE thread_id = ?", former.thread_id).length, 1);
  appendFileSync(next.transcriptPath, answer(3, "Rebound reply"));
  await box.call("Stop", { ...next, terminationReason: "model_stop" });
  const rebound = await until(() => box.sql("SELECT parent_turn_id FROM turns WHERE thread_id = ? AND parent_turn_id IS NOT NULL",
    aThread.thread_id)[0], "rebound turn");
  assert.equal(rebound.parent_turn_id, aThread.head_turn_id);

  const req = "Fresh after displacement";
  const displaced = await putTurn(box, first, req, 2);
  assert.notEqual(displaced.thread_id, aThread.thread_id);
  assert.equal(displaced.title, req);
  assert.equal(box.sql("SELECT * FROM turns WHERE thread_id = ?", displaced.thread_id).length, 1);
});

test("normal Stop persists while the daemon is unavailable, and recovery respects the captured EOF", async (t) => {
  const box = sandbox(t);
  const work = join(box.root, "work");
  mkdirSync(work);
  const w = window(work, "buffered");
  await box.start(); await box.watch(work); await box.stop();
  const lock = new DatabaseSync(join(box.root, "daemon.lock.sqlite"));
  try {
    lock.exec("BEGIN EXCLUSIVE");
    appendFileSync(w.transcriptPath, user(0, "Committed at Stop") + answer(1, "Finished answer"));
    const start = performance.now();
    assert.deepEqual(await box.call("Stop", { ...w, terminationReason: "NO_TOOL_CALL", lastUserInput: "never persist me" }), { decision: "stop" });
    assert.ok(performance.now() - start < 4000);
    const files = readdirSync(join(box.root, "hook-inbox"));
    assert.equal(files.length, 1);
    assert.doesNotMatch(readFileSync(join(box.root, "hook-inbox", files[0]), "utf8"), /never persist me/);
    appendFileSync(w.transcriptPath, user(2, "Later turn") + answer(3, "Not stopped yet"));
  } finally { lock.close(); }
  await box.start();
  assert.equal(box.sql("SELECT count(*) AS n FROM turns")[0].n, 1);
  assert.deepEqual(readdirSync(join(box.root, "hook-inbox")), []);
  await box.call("Stop", { ...w, terminationReason: "NO_TOOL_CALL" });
  await until(() => box.sql("SELECT count(*) AS n FROM turns")[0].n === 2, "later Stop recovered");
  await box.call("Stop", { ...w, terminationReason: "NO_TOOL_CALL" });
  await until(() => readdirSync(join(box.root, "hook-inbox")).length === 0, "duplicate Stop discarded");
  assert.equal(box.sql("SELECT count(*) AS n FROM turns")[0].n, 2);
});

test("Antigravity injects only unread turns and reports Git drift once per user step", async (t) => {
  const box = sandbox(t);
  const work = join(box.root, "work");
  mkdirSync(work);
  const w = window(work, "git-context");
  const git = (...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: work, stdio: "ignore" });
  git("init", "-q");
  const file = join(work, "code.txt");
  writeFileSync(file, "first\n"); git("add", "code.txt"); git("commit", "-qm", "first");
  await box.start(); await box.watch(work);
  const initial = await putTurn(box, w, "Initial answer");
  const codex = await until(() => box.sql("SELECT native_path FROM bindings WHERE thread_id = ? AND agent = 'codex' AND mirror_pending = 0",
    initial.thread_id)[0], "Codex mirror");
  const row = (type, fields) => JSON.stringify({ type: "event_msg", payload: { type, ...fields } }) + "\n";
  appendFileSync(codex.native_path, row("task_started", { turn_id: "new" }) + row("user_message", { message: "Codex delta question" }) +
    row("agent_message", { message: "Only this new Codex answer" }) + row("task_complete", { turn_id: "new" }));
  await until(() => box.sql("SELECT 1 FROM turns WHERE origin_agent = 'codex'")[0], "Codex delta");
  writeFileSync(file, "changed\n"); git("add", "code.txt"); git("commit", "-qm", "changed");
  appendFileSync(w.transcriptPath, user(2, "Continue"));
  const request = { ...w, invocationNum: 0, lastUserInput: "Continue" };
  const text = history(await box.call("PreInvocation", request));
  assert.match(text, /Only this new Codex answer/);
  assert.doesNotMatch(text, /Initial answer/);
  assert.match(text, /<workspace_state_reset>[\s\S]*\.\/code\.txt/);
  writeFileSync(file, "changed in the same turn\n");
  assert.deepEqual(await box.call("PreInvocation", { ...request, invocationNum: 1 }), {});
  assert.deepEqual(await box.call("PreInvocation", request), {});
});
