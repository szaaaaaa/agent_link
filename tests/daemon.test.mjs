import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openStateDb } from "../dist/core/db.js";
import { normalizeWorkspace } from "../dist/core/workspace.js";
import { DaemonUnavailable, request } from "../dist/daemon/lifecycle.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const exec = promisify(execFile);

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "al-d-"));
  const piRoot = join(dir, "pi-sessions");
  const codexHome = join(dir, "codex");
  const env = { ...process.env, AGENT_LINK_CODEX_AUTO_SYNC: "0", AGENT_LINK_HOME: dir, PI_CODING_AGENT_DIR: join(dir, "pi"),
    PI_CODING_AGENT_SESSION_DIR: piRoot, CODEX_HOME: codexHome };
  const processes = [];
  t.after(async () => {
    await request(dir, "daemon-stop").catch(() => {});
    for (const { child, done } of processes) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await done;
    }
    // Autostart launches a detached process; allow its final handle closes before removing the directory.
    await delay(150);
    rmSync(dir, { force: true, recursive: true, maxRetries: 5 });
  });
  return {
    dir, piRoot, codexHome,
    async cli(...args) {
      const { stdout } = await exec(process.execPath, [cli, ...args], { env, timeout: 5000, encoding: "utf8" });
      return JSON.parse(stdout);
    },
    spawn(...args) {
      const child = spawn(process.execPath, args, { env, stdio: ["ignore", "ignore", "pipe"] });
      let errors = "";
      child.stderr.setEncoding("utf8").on("data", (text) => { errors += text; });
      const done = new Promise((resolve) => {
        child.once("close", (code) => resolve({ code, errors }));
      });
      const launched = { child, done };
      processes.push(launched);
      return launched;
    },
  };
}

async function until(probe, description, timeout = 4000) {
  const start = performance.now();
  for (;;) {
    const result = await probe();
    if (result) return result;
    if (performance.now() - start > timeout) throw new Error(description + " did not become true");
    await delay(12);
  }
}

function running(dir) {
  return until(() => request(dir, "daemon-status").catch((error) => {
    if (error instanceof DaemonUnavailable) return false;
    throw error;
  }), "daemon status");
}

test("concurrent CLI startup elects one daemon and reclaims stale state after a hard kill", async (t) => {
  const box = sandbox(t);
  assert.deepEqual(await box.cli("daemon", "status"), { running: false });
  const first = box.spawn(cli, "daemon", "run");
  const second = box.spawn(cli, "daemon", "run");
  const active = await running(box.dir);
  const winner = [first, second].find(({ child }) => child.pid === active.pid);
  assert.ok(winner);
  const loser = winner === first ? second : first;
  const rejected = await loser.done;
  assert.equal(rejected.code, 1);
  assert.match(rejected.errors, /Daemon already running/);
  assert.equal((await box.cli("daemon", "start")).pid, active.pid);

  winner.child.kill("SIGKILL");
  await winner.done;
  assert.equal((await box.cli("daemon", "status")).running, false);
  const workspace = join(box.dir, "project");
  mkdirSync(workspace);
  assert.equal((await box.cli("watch", workspace)).enabled, true); // auto-spawns the replacement
  assert.notEqual((await box.cli("daemon", "status")).pid, active.pid);
  assert.equal((await box.cli("status", workspace)).workspaces[0].workspace_key, normalizeWorkspace(workspace));
  assert.equal((await box.cli("unwatch", workspace)).enabled, false);
  assert.deepEqual(JSON.parse(readFileSync(join(box.dir, "config.json"), "utf8")), { workspaces: [] });
  assert.equal((await box.cli("daemon", "stop")).running, true);
});

test("daemon incrementally syncs a turn past 100 MiB and respects the live whitelist", async (t) => {
  const { dir, spawn: launch } = sandbox(t);
  const workspace = join(dir, "project");
  mkdirSync(workspace);
  const source = join(dir, "source.jsonl");
  const target = join(dir, "target.jsonl");
  const fd = openSync(source, "w");
  const block = Buffer.alloc(1024 * 1024, 0x61);
  try {
    for (let i = 0; i < 100; i++) writeSync(fd, block);
    writeSync(fd, "\n");
  } finally { closeSync(fd); }
  writeFileSync(target, "");
  const key = normalizeWorkspace(workspace);
  const db = openStateDb(dir);
  try {
    db.prepare("INSERT INTO workspaces VALUES (?, ?, 1, 0)").run(key, workspace);
    db.prepare("INSERT INTO threads (thread_id, workspace_key, title, created_at, updated_at) VALUES ('th_test', ?, 'Test', 0, 0)").run(key);
    for (const [agent, path] of [["pi", source], ["codex", target]]) {
      db.prepare("INSERT INTO bindings (thread_id, agent, native_session_id, native_path, updated_at) VALUES ('th_test', ?, ?, ?, 0)")
        .run(agent, agent, path);
    }
  } finally { db.close(); }

  const server = new URL("../dist/daemon/server.js", import.meta.url).href;
  launch("--input-type=module", "-e", `
    import { serve } from ${JSON.stringify(server)};
    const adapter = {
      reader: (binding) => (text) => text === null ? null : {
        anchor: text, userText: text, assistantText: "ok", parentTurnId: binding.last_written_turn_id, tools: [],
      },
      withWritable: async (_, run) => run(),
      encode: (turn) => JSON.stringify({ copied: turn.user_text }) + "\\n",
    };
    await serve(process.env.AGENT_LINK_HOME, { pi: adapter, codex: adapter });
  `);
  const ready = await running(dir);
  await request(dir, "unwatch", workspace);
  appendFileSync(source, '"first turn"\n');
  await delay(600);
  assert.equal(readFileSync(target, "utf8"), "");
  const start = performance.now();
  await request(dir, "watch", workspace);
  await until(() => readFileSync(target, "utf8").includes("first turn"), "target mirror");
  const elapsed = performance.now() - start;
  // A visible append can precede the cursor commit. Status is serialized after that commit.
  const status = await request(dir, "status", workspace);
  const after = await request(dir, "daemon-status");
  const increment = after.peakRss - ready.rss;
  t.diagnostic(`incremental sync ${elapsed.toFixed(0)} ms; peak RSS increase ${(increment / 1e6).toFixed(2)} MB; daemon RSS ${(after.rss / 1e6).toFixed(2)} MB`);
  assert.equal(status.threads[0].status, "SYNCED");
  assert.equal(JSON.parse(readFileSync(target, "utf8")).copied, '"first turn"');
  assert.ok(elapsed < 1000, "incremental sync exceeded 1 second");
  assert.ok(increment < 30_000_000, "incremental peak RSS increase exceeded 30 MB");
  assert.ok(after.rss <= 80_000_000, "daemon RSS exceeded 80 MB");
});

function nativeRows(agent) {
  return readFileSync(new URL(`./fixtures/${agent}-native.jsonl`, import.meta.url), "utf8").trimEnd().split("\n").map(JSON.parse);
}

function writeRows(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function state(dir, query) {
  const db = new DatabaseSync(join(dir, "state.sqlite"), { readOnly: true });
  try { return db.prepare(query).all(); }
  finally { db.close(); }
}

test("default daemon discovers only allowlisted native sessions, including newly created date directories", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.dir, "project");
  const childWorkspace = join(workspace, "child");
  mkdirSync(childWorkspace, { recursive: true });
  const active = box.spawn(cli, "daemon", "run");
  await running(box.dir);
  await box.cli("watch", workspace);

  const pi = nativeRows("pi");
  pi[0].cwd = workspace;
  const piPath = join(box.piRoot, "arbitrary-name", "session.jsonl");
  writeRows(piPath, pi);
  const blocked = structuredClone(pi);
  Object.assign(blocked[0], { id: "blocked-workspace", cwd: childWorkspace });
  writeRows(join(box.piRoot, "blocked.jsonl"), blocked);
  const external = join(box.dir, "external");
  Object.assign(blocked[0], { id: "linked-external", cwd: workspace });
  writeRows(join(external, "session.jsonl"), blocked);
  symlinkSync(external, join(box.piRoot, "link"), process.platform === "win32" ? "junction" : "dir");

  const codex = nativeRows("codex");
  codex[0].payload.cwd = workspace;
  const day1 = join(box.codexHome, "sessions", "2026", "11", "24");
  const day2 = join(box.codexHome, "sessions", "2026", "11", "25");
  const delegated = structuredClone(codex);
  Object.assign(delegated[0].payload, { id: "delegated", session_id: "delegated", source: { subagent: {} } });
  writeRows(join(day1, "rollout-subagent.jsonl"), delegated);
  const codexPath = join(day1, "rollout-first.jsonl");
  writeRows(codexPath, codex.slice(0, -1));
  const threads = async () => (await request(box.dir, "status", workspace)).threads;
  await until(async () => (await threads()).length === 1, "Pi discovery and Codex incomplete turn");
  assert.ok((await threads())[0].bindings.some((binding) => binding.native_session_id === pi[0].id));
  const started = performance.now();
  appendFileSync(codexPath, JSON.stringify(codex.at(-1)) + "\n");
  await until(async () => (await threads()).length === 2, "Codex closed turn");
  assert.ok(performance.now() - started >= 475, "Codex close was accepted without the 500 ms quiet period");
  assert.equal((await threads()).find((thread) => thread.bindings.some((binding) =>
    binding.native_session_id === codex[0].payload.id)).title, "Sample question.");

  // A copied ID must not rebind or advance the original. A genuinely new session is independent.
  writeRows(join(day2, "rollout-duplicate.jsonl"), codex);
  Object.assign(codex[0].payload, { id: "day-two", session_id: "day-two" });
  writeRows(join(day2, "rollout-next-day.jsonl"), codex);
  await until(async () => (await threads()).length === 3, "next-day discovery");
  assert.deepEqual(state(box.dir, "SELECT native_session_id FROM bindings b WHERE EXISTS (SELECT 1 FROM turns t WHERE t.turn_id = b.last_seen_turn_id AND t.origin_agent = b.agent) ORDER BY agent, native_session_id")
    .map((row) => row.native_session_id), ["01a21066-2f1a-7fb2-b3ba-95b4bfaccf3e", "day-two", pi[0].id]);
  assert.equal(readFileSync(piPath, "utf8"), pi.map((row) => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(state(box.dir, "SELECT count(*) AS n FROM native_writes")[0].n, 0);
  await request(box.dir, "daemon-stop");
  assert.equal((await active.done).code, 0);
});

test("Pi preserves its parent chain across restart and respects unwatch and file replacement", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.dir, "project");
  mkdirSync(workspace);
  const pi = nativeRows("pi");
  pi[0].cwd = workspace;
  const path = join(box.piRoot, "session.jsonl");
  writeRows(path, pi);
  const first = box.spawn(cli, "daemon", "run");
  await running(box.dir);
  await box.cli("watch", workspace);
  const turns = () => state(box.dir, "SELECT turn_id, parent_turn_id FROM turns ORDER BY created_at");
  await until(() => turns().length === 1, "initial Pi turn");
  const root = turns()[0].turn_id;
  await box.cli("unwatch", workspace);
  const add = (id, parentId) => {
    const user = { ...pi.at(-2), id: `user-${id}`, parentId };
    const answer = { ...pi.at(-1), id: `answer-${id}`, parentId: user.id };
    appendFileSync(path, JSON.stringify(user) + "\n" + JSON.stringify(answer) + "\n");
  };
  add("one", pi.at(-1).id);
  await delay(1050);
  assert.equal(turns().length, 1);
  await request(box.dir, "daemon-stop");
  assert.equal((await first.done).code, 0);
  const second = box.spawn(cli, "daemon", "run");
  await running(box.dir);
  await box.cli("watch", workspace);
  await until(() => turns().length === 2, "Pi incremental resume");
  assert.equal(turns()[1].parent_turn_id, root);
  add("fork", pi.at(-1).id);
  await until(() => turns().length === 3, "Pi stale branch");
  assert.equal(turns()[2].parent_turn_id, root);
  assert.equal((await request(box.dir, "status", workspace)).threads[0].marker, "[fork]");

  renameSync(path, join(box.piRoot, "old.data"));
  writeFileSync(path, readFileSync(join(box.piRoot, "old.data")));
  add("replacement", "answer-fork");
  await delay(1050);
  assert.equal(turns().length, 3);
  await request(box.dir, "daemon-stop");
  assert.equal((await second.done).code, 0);
});

test("publishes the first mirror once; Pi injection is acknowledged only after Pi persists it", async (t) => {
  const box = sandbox(t);
  const workspace = join(box.dir, "project");
  mkdirSync(workspace);
  const pi = nativeRows("pi");
  pi[0].cwd = workspace;
  const path = join(box.piRoot, "pi.jsonl");
  writeRows(path, pi);
  let process = box.spawn(cli, "daemon", "run");
  await running(box.dir);
  await box.cli("watch", workspace);
  const mirror = () => state(box.dir, "SELECT * FROM bindings WHERE agent = 'codex' AND mirror_pending = 0")[0];
  const codex = await until(mirror, "published Codex mirror");
  const file = readFileSync(codex.native_path, "utf8");
  assert.match(file, /Sample question\./);
  assert.match(file, /Sample reply\./);
  assert.equal(file.split("\n").filter(Boolean).length, 8);
  assert.equal(codex.native_notice, `codex resume ${codex.native_session_id}`);
  await request(box.dir, "daemon-stop");
  assert.equal((await process.done).code, 0);
  // Recreate the durable state after the staging commit and before the publish link.
  renameSync(codex.native_path, codex.native_path + ".agent-link-pending");
  const db = new DatabaseSync(join(box.dir, "state.sqlite"));
  try { db.exec("UPDATE bindings SET mirror_pending = 1 WHERE agent = 'codex'"); }
  finally { db.close(); }
  process = box.spawn(cli, "daemon", "run");
  await running(box.dir);
  assert.equal((await until(mirror, "recovered mirror")).native_session_id, codex.native_session_id);
  assert.equal(readFileSync(codex.native_path, "utf8"), file);

  const fixture = nativeRows("codex").slice(1);
  for (const row of fixture) {
    const p = row.payload;
    if (p.item?.type === "UserMessage") p.item.content[0].text = "Followup from Codex?";
    if (p.item?.type === "AgentMessage") p.item.content[0].text = "Unique Codex conclusion.";
    if (p.type === "task_complete") p.last_agent_message = "Unique Codex conclusion.";
  }
  appendFileSync(codex.native_path, fixture.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const nativeCodex = readFileSync(codex.native_path);
  const ask = (leaf, cwd = workspace) => request(box.dir, "pi-pull", JSON.stringify({ path, cwd, leaf }));
  const pulled = await until(() => ask(pi.at(-1).id), "unread Pi history");
  assert.equal(pulled.count, 1);
  assert.match(pulled.content, /Unique Codex conclusion/);
  assert.equal(await ask(pi.at(-1).id, box.dir), null);
  assert.equal(state(box.dir, "SELECT last_seen_turn_id FROM bindings WHERE agent = 'pi'")[0].last_seen_turn_id,
    codex.last_written_turn_id);
  assert.deepEqual(await ask(pi.at(-1).id), pulled);
  const injected = { id: "persisted-custom", type: "custom_message", customType: "agent-link", parentId: pi.at(-1).id,
    details: { turnId: pulled.turnId }, content: pulled.content, display: true };
  appendFileSync(path, JSON.stringify(injected) + "\n");
  await until(() => state(box.dir, "SELECT last_seen_turn_id FROM bindings WHERE agent = 'pi'")[0].last_seen_turn_id === pulled.turnId,
    "persisted Pi acknowledgement");
  assert.equal(await ask(injected.id), null);
  const cursors = state(box.dir, "SELECT last_written_turn_id, last_seen_turn_id, last_timeline_turn_id FROM bindings WHERE agent = 'pi'")[0];
  assert.equal(cursors.last_seen_turn_id, pulled.turnId);
  assert.equal(cursors.last_written_turn_id, codex.last_written_turn_id);
  assert.equal(cursors.last_timeline_turn_id, codex.last_written_turn_id);
  assert.equal(state(box.dir, "SELECT count(*) AS count FROM turns")[0].count, 2);
  assert.deepEqual(readFileSync(codex.native_path), nativeCodex);
  assert.equal(state(box.dir, "SELECT count(*) AS count FROM threads")[0].count, 1);
  await request(box.dir, "daemon-stop");
  assert.equal((await process.done).code, 0);
});

test("Windows offline sync refuses competing writers and appends existing Pi and Codex sessions without echo", {
  skip: process.platform !== "win32",
}, async (t) => {
  const box = sandbox(t);
  const workspace = join(box.dir, "project");
  mkdirSync(workspace);
  const pi = nativeRows("pi");
  pi[0].cwd = workspace;
  const path = join(box.piRoot, "pi.jsonl");
  writeRows(path, pi);
  const daemon = box.spawn(cli, "daemon", "run");
  await running(box.dir);
  await box.cli("watch", workspace);
  const codex = await until(() => state(box.dir, "SELECT * FROM bindings WHERE agent = 'codex' AND mirror_pending = 0")[0], "mirror");
  const event = (type, fields) => ({ type: "event_msg", payload: { type, ...fields } });
  const newTurn = [event("task_started", { turn_id: "native" }), event("user_message", { message: "Codex offline question" }),
    event("agent_message", { message: "Codex offline response" }), event("task_complete", { turn_id: "native" })];
  const lastOrdinal = JSON.parse(readFileSync(codex.native_path, "utf8").trimEnd().split("\n").at(-1)).ordinal;
  appendFileSync(codex.native_path, newTurn.map((row, i) => JSON.stringify({ ...row, ordinal: lastOrdinal + i + 1 })).join("\n") + "\n");
  const newer = await until(() => state(box.dir, "SELECT turn_id FROM turns WHERE origin_agent = 'codex'")[0], "new Codex turn");
  const sync = (agent) => request(box.dir, "sync-offline", JSON.stringify({ threadId: codex.thread_id, agent, closed: true }), 12000);
  const original = readFileSync(path);
  const piSync = (leaf) => request(box.dir, "pi-sync", JSON.stringify({ path, cwd: workspace, leaf }), 12000);
  const held = openSync(path, "a");
  try { await assert.rejects(piSync(pi.at(-1).id), /Cannot acquire exclusive writer lease/); }
  finally { closeSync(held); }
  assert.deepEqual(readFileSync(path), original);
  assert.equal(state(box.dir, "SELECT count(*) AS n FROM native_writes")[0].n, 0);

  appendFileSync(path, '{"type":"model_change","id":"hold","parentId":' + JSON.stringify(pi.at(-1).id));
  const partial = readFileSync(path);
  await assert.rejects(sync("pi"), /incomplete or unread native record/);
  assert.deepEqual(readFileSync(path), partial);
  appendFileSync(path, "}\n");
  const complete = readFileSync(path);
  await assert.rejects(piSync(pi.at(-1).id), /disk leaf does not match/);
  assert.deepEqual(readFileSync(path), complete);
  assert.equal((await piSync("hold")).appended_turns, 1);
  const leaf = `al_${newer.turn_id}_a`;
  assert.equal(JSON.parse(readFileSync(path, "utf8").trimEnd().split("\n").at(-1)).id, leaf);
  assert.equal((await sync("pi")).appended_turns, 0);

  const user = { ...pi.at(-2), id: "user-after-offline", parentId: leaf };
  const answer = { ...pi.at(-1), id: "answer-after-offline", parentId: user.id };
  appendFileSync(path, JSON.stringify(user) + "\n" + JSON.stringify(answer) + "\n");
  await until(() => state(box.dir, "SELECT 1 AS found FROM turns WHERE origin_agent = 'pi' AND parent_turn_id IS NOT NULL").length, "Pi continuation");
  assert.equal((await sync("codex")).appended_turns, 1);
  const synced = readFileSync(codex.native_path, "utf8");
  const tail = JSON.parse(synced.trimEnd().split("\n").at(-1));
  assert.equal(tail.ordinal, lastOrdinal + newTurn.length + 7);
  assert.match(tail.payload.last_agent_message, /Sample reply/);
  assert.equal((await sync("codex")).appended_turns, 0);
  assert.equal(readFileSync(codex.native_path, "utf8"), synced);
  assert.equal(state(box.dir, "SELECT count(*) AS n FROM turns")[0].n, 3);
  assert.equal(state(box.dir, "SELECT count(*) AS n FROM native_writes WHERE status = 'done'")[0].n, 2);

  const forkUser = { ...user, id: "offline-fork-user", parentId: answer.id };
  const forkAnswer = { ...answer, id: "offline-fork-answer", parentId: forkUser.id };
  appendFileSync(path, JSON.stringify(forkUser) + "\n" + JSON.stringify(forkAnswer) + "\n");
  await until(() => state(box.dir, "SELECT count(*) AS n FROM turns")[0].n === 4, "Pi main branch");
  appendFileSync(codex.native_path, newTurn.map((row, i) => JSON.stringify({ ...row, ordinal: tail.ordinal + i + 1,
    payload: { ...row.payload, turn_id: "competing" } })).join("\n") + "\n");
  const beforeFork = readFileSync(codex.native_path);
  await assert.rejects(sync("codex"), /caused a fork|not SYNCED/);
  assert.deepEqual(readFileSync(codex.native_path), beforeFork);
  assert.equal(state(box.dir, "SELECT status FROM threads")[0].status, "DIVERGED");
  await assert.rejects(piSync(forkAnswer.id), /not SYNCED/);
  assert.equal(state(box.dir, "SELECT count(*) AS n FROM turns")[0].n, 5);
  assert.equal(state(box.dir, "SELECT count(*) AS n FROM native_writes")[0].n, 2);
  await request(box.dir, "daemon-stop");
  assert.equal((await daemon.done).code, 0);
});
