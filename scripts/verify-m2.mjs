// Run after npm run build. PI_CLI and CODEX_CLI are absolute executable or JS entry paths.
// On Windows, set AGY_CLI to the official executable to include the task 6 acceptance run.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { request } from "../dist/daemon/lifecycle.js";

const { PI_CLI: pi, CODEX_CLI: codex, AGY_CLI: agy } = process.env;
assert.ok(pi && codex, "Set PI_CLI and CODEX_CLI");
const root = await mkdtemp(join(tmpdir(), "al-m2-"));
const [workspace, seed, piDir, codexDir, agentDir] = ["work", "seed", "pi", "codex", "agent"].map((dir) => join(root, dir));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const projector = join(root, "projector.cjs");
const environment = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), PI_CODING_AGENT_DIR: piDir,
  PI_CODING_AGENT_SESSION_DIR: join(piDir, "sessions"), CODEX_HOME: codexDir, AGENT_LINK_HOME: agentDir,
  AGENT_LINK_CODEX_CLI: projector, AGENT_LINK_CODEX_AUTO_SYNC: "0", AGENT_LINK_AGY_FIRST_INVOCATION: "0" };
const agyEnvironment = { ...environment, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "local"),
  GEMINI_API_KEY: "dummy-fixture" };
const children = new Set();
const commands = (entry, args) => /\.[cm]?js$/i.test(entry) ? [process.execPath, [entry, ...args]] : [entry, args];
const exec = (entry, args, cwd = workspace, env = environment) => new Promise((resolve, reject) => {
  const child = execFile(...commands(entry, args), { cwd, env, timeout: 20_000 },
    (error, stdout) => error ? reject(error) : resolve(stdout));
  child.stdin.end();
});

function rpc(entry, args) {
  const child = spawn(...commands(entry, args), { cwd: workspace, env: environment, windowsHide: true });
  const done = new Promise((resolve) => child.once("close", resolve));
  children.add({ child, done });
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
  const pending = new Map();
  const events = [];
  let id = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined) pending.get(message.id)?.(message);
    else events.push(message);
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const call = (params) => new Promise((resolve, reject) => {
    const key = String(++id);
    const timeout = setTimeout(() => reject(new Error(`${JSON.stringify(params)} timed out; ${errors}`)), 8000);
    pending.set(key, (reply) => { clearTimeout(timeout); pending.delete(key); resolve(reply); });
    send({ ...params, id: key });
  });
  return { child, call, send, events, done };
}

async function wait(probe, reason) {
  for (let i = 0; i < 120; i++) {
    const value = await probe();
    if (value) return value;
    await delay(30);
  }
  throw new Error("Timed out: " + reason);
}

const requests = { pi: [], codex: [], agy: [] };
const agyEdit = "Antigravity created this fixture.\n";
let agyWrite = false;
function sse(response, event, payload) {
  response.write((event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(payload)}\n\n`);
}
const mock = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (req.url.includes("streamGenerateContent")) {
    requests.agy.push(body);
    const tools = body.tools?.flatMap((row) => row.functionDeclarations ?? row.function_declarations ?? []) ?? [];
    const write = agyWrite && tools.find((tool) => tool.name === "write_file" || tool.name === "write_to_file");
    if (write) agyWrite = false;
    const args = write && Object.fromEntries(Object.keys((write.parameters ?? write.parametersJsonSchema)?.properties ?? {}).flatMap((key) => {
      const normalized = key.toLowerCase().replaceAll("_", "");
      if (["targetfile", "path", "filepath"].includes(normalized)) return [[key, join(workspace, "agy-change.txt")]];
      if (["content", "codecontent"].includes(normalized)) return [[key, agyEdit]];
      if (["overwrite", "emptyfile"].includes(normalized)) return [[key, false]];
      if (["toolaction", "toolsummary", "description"].includes(normalized)) return [[key, "Create isolated fixture"]];
      return [];
    }));
    const part = write ? { functionCall: { name: write.name, args } } : { text: `Antigravity answer ${requests.agy.length}.` };
    sse(res, null, { candidates: [{ index: 0, content: { role: "model", parts: [part] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } });
    res.end();
  } else if (req.url.endsWith("/chat/completions")) {
    const n = requests.pi.push(body);
    const base = { id: "mock-pi-" + n, object: "chat.completion.chunk", created: 1, model: "fixture" };
    for (const choice of [{ index: 0, delta: { role: "assistant", content: `Pi answer ${n}.` }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" }]) sse(res, null, { ...base, choices: [choice] });
    res.end("data: [DONE]\n\n");
  } else {
    const n = requests.codex.push(body);
    const text = `Codex answer ${n}.`;
    const msg = { id: "msg_fixture_" + n, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }] };
    const usage = { input_tokens: 10, output_tokens: 3, total_tokens: 13,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
    const response = { id: "resp_fixture_" + n, object: "response", status: "completed", model: "gpt-5", output: [msg], usage };
    for (const event of [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...msg, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: msg.id, output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item: msg }, { type: "response.completed", response }]) {
      sse(res, event.type, event);
    }
    res.end();
  }
});

function readDb(sql) {
  const db = new DatabaseSync(join(agentDir, "state.sqlite"), { readOnly: true });
  try { return db.prepare(sql).get(); } finally { db.close(); }
}

try {
  for (const dir of [workspace, seed, piDir, codexDir]) await mkdir(dir);
  const commit = async (body) => {
    await writeFile(join(workspace, "tracked.txt"), body);
    await exec("git", ["add", "tracked.txt"]);
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
      "commit", "-qm", "Fixture change"]);
  };
  await exec("git", ["init", "-q"]);
  await commit("Initial fixture.\n");
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${mock.address().port}/v1`;
  await writeFile(join(piDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: base, api: "openai-completions", apiKey: "dummy", models: [{ id: "fixture" }],
  } } }));
  await writeFile(join(codexDir, "config.toml"), `model = "gpt-5"\nmodel_provider = "fixture"\n` +
    `[model_providers.fixture]\nname = "fixture"\nbase_url = "${base}"\nwire_api = "responses"\nsupports_websockets = false\n`);
  if (agy) {
    const settings = join(root, ".gemini", "antigravity-cli");
    await mkdir(settings, { recursive: true });
    await writeFile(join(settings, "settings.json"), JSON.stringify({ modelProvider: "gemini", agentMode: "accept-edits" }));
    agyEnvironment.GOOGLE_GEMINI_BASE_URL = base.slice(0, -3);
  }
  await exec(cli, ["install"]);
  await exec(codex, ["exec", "--skip-git-repo-check", "Seed index."], seed);
  let daemon = rpc(cli, ["daemon", "run"]);
  await wait(() => request(agentDir, "daemon-status").catch(() => null), "daemon ready");
  await request(agentDir, "watch", workspace);
  const piRpc = rpc(pi, ["--mode", "rpc", "--offline", "-ns", "-np", "-nc", "--no-mcp",
    "--provider", "fixture", "--model", "fixture"]);
  const prompt = async (message) => {
    const before = piRpc.events.filter((event) => event.type === "agent_settled").length;
    const reply = await piRpc.call({ type: "prompt", message });
    assert.equal(reply.success, true, JSON.stringify(reply));
    if (reply.data.disposition === "started") {
      await wait(() => piRpc.events.filter((event) => event.type === "agent_settled").length > before, "Pi settled");
    }
    return reply.data.disposition;
  };
  assert.equal(await prompt("Pi first question."), "started");
  const codexBinding = await wait(() => readDb("SELECT * FROM bindings WHERE agent = 'codex' AND mirror_pending = 0"), "mirror");
  assert.equal(codexBinding.native_notice, null);
  const piBinding = readDb("SELECT * FROM bindings WHERE agent = 'pi'");
  const readCodex = async (length, binding = codexBinding, paginated = false) => {
    const app = rpc(codex, ["app-server"]);
    const init = await app.call({ method: "initialize", params: { clientInfo: { name: "agent-link-test", version: "0.1.0" } } });
    assert.ok(init.result, JSON.stringify(init));
    app.send({ method: "initialized" });
    try {
      const result = await app.call({ method: "thread/read", params: { threadId: binding.native_session_id, includeTurns: true } });
      assert.equal(result.result?.thread.turns.length, length, JSON.stringify(result));
      const list = await app.call({ method: "thread/list", params: { modelProviders: ["fixture"], sourceKinds: ["cli", "exec"], limit: 50 } });
      assert.ok(list.result?.data.some((row) => row.id === binding.native_session_id));
      assert.equal(result.result.thread.id, binding.native_session_id);
      if (paginated) {
        const params = { threadId: binding.native_session_id, limit: 25, sortDirection: "asc" };
        const turns = await app.call({ method: "thread/turns/list", params: { ...params, itemsView: "full" } });
        assert.deepEqual(turns.result?.data.map((turn) => turn.id), result.result.thread.turns.map((turn) => turn.id), JSON.stringify(turns));
        const turnId = turns.result.data.at(-1).id;
        const items = await app.call({ method: "thread/items/list", params: { ...params, turnId } });
        const types = items.result?.data.map((entry) => (entry.item ?? entry).type);
        assert.ok(types?.includes("userMessage") && types?.includes("agentMessage"), JSON.stringify(items));
      }
      return result.result.thread.turns;
    } finally { app.child.stdin.end(); }
  };
  const [first] = await readCodex(1);
  assert.deepEqual(first.items.map((i) => i.type), ["userMessage", "agentMessage"]);
  assert.match(first.items[1].text, /Pi answer 1\./);
  const originalPi = await readFile(piBinding.native_path);
  await exec(codex, ["exec", "resume", "--skip-git-repo-check", codexBinding.native_session_id, "Codex continuation."]);
  const actualCodex = await readFile(codexBinding.native_path);
  const [, followup] = await readCodex(2);
  assert.match(JSON.stringify(followup.items), /Codex answer 2\./);
  const before = await wait(() => {
    const turn = readDb("SELECT * FROM turns WHERE origin_agent = 'codex'");
    return turn && turn.turn_id;
  }, "Codex turn ingested");
  assert.deepEqual(await readFile(piBinding.native_path), originalPi);
  await commit("Windows Pi should reread this file.\n");
  assert.equal(await prompt("Pi followup."), "started");
  const piPayload = JSON.stringify(requests.pi[1].messages);
  assert.ok(piPayload.includes("Codex answer 2."), "Pi receives the Codex delta");
  assert.ok(piPayload.includes("workspace_state_reset") && piPayload.includes("./tracked.txt"), "Pi receives committed-file drift");
  const entries = async () => (await readFile(piBinding.native_path, "utf8")).trimEnd().split("\n").map(JSON.parse);
  const current = (await entries()).filter((row) => row.customType === "agent-link");
  assert.equal(current.length, 1);
  assert.equal(current[0].details.turnId, before);
  const piAfter = await wait(() => readDb(`SELECT * FROM turns WHERE origin_agent = 'pi' AND parent_turn_id = '${before}'`), "Pi injection parent");
  assert.equal(readDb("SELECT last_seen_turn_id FROM bindings WHERE agent = 'pi'").last_seen_turn_id, piAfter.turn_id);
  assert.equal(await prompt("/sync"), "handled");
  assert.equal(requests.pi.length, 2);
  if (process.platform === "win32") {
    assert.equal((await entries()).at(-1).id, `al_${before}_a`);
    const visible = (await piRpc.call({ type: "get_messages" })).data.messages;
    assert.ok(visible.some((msg) => msg.role === "assistant" && JSON.stringify(msg.content).includes("Codex answer 2.")));
  }
  assert.equal((await entries()).filter((row) => row.customType === "agent-link").length, 1);
  assert.deepEqual(await readFile(codexBinding.native_path), actualCodex);
  assert.equal(readDb("SELECT count(*) AS n FROM turns").n, 3);
  assert.equal(readDb("SELECT status FROM threads").status, "SYNCED");
  if (process.platform === "win32") {
    piRpc.child.stdin.end();
    await wait(() => piRpc.child.exitCode === 0, "close Pi before offline sync");
    const offline = async (binding, agent) => JSON.parse(await exec(cli, ["sync-offline", binding.thread_id, agent, "--closed"]));
    const index = new DatabaseSync(join(codexDir, "state_5.sqlite"));
    try { index.prepare("UPDATE threads SET updated_at = 1 WHERE id = ?").run(codexBinding.native_session_id); }
    finally { index.close(); }
    const flushed = await offline(codexBinding, "codex");
    assert.equal(flushed.appended_turns, 1);
    assert.equal(flushed.notice, null, JSON.stringify(flushed));
    const recency = new DatabaseSync(join(codexDir, "state_5.sqlite"), { readOnly: true });
    try {
      const indexed = recency.prepare("SELECT updated_at, rollout_path FROM threads WHERE id = ?").get(codexBinding.native_session_id);
      assert.ok(indexed.updated_at > 1, JSON.stringify({ indexed, path: codexBinding.native_path }));
    } finally { recency.close(); }
    const codexOnly = (await readCodex(3)).at(-1);
    assert.deepEqual(codexOnly.items.map((i) => i.type), ["userMessage", "agentMessage"]);
    assert.match(codexOnly.items[1].text, /Pi answer 2\./);
    assert.equal((await offline(codexBinding, "codex")).appended_turns, 0);

    await exec(codex, ["exec", "resume", "--skip-git-repo-check", codexBinding.native_session_id, "Codex offline relay."]);
    const offHead = await wait(() => readDb("SELECT * FROM turns WHERE origin_agent = 'codex' AND created_at > " + piAfter.created_at),
      "offline Codex turn ingested");
    assert.equal((await offline(piBinding, "pi")).appended_turns, 1);
    assert.ok((await entries()).some((entry) => entry.id === `al_${offHead.turn_id}_a`));
    const piArgs = ["--offline", "-ns", "-np", "-nc", "--no-mcp", "--provider", "fixture", "--model", "fixture"];
    const piResume = (binding, text, ...extra) => exec(pi, ["--session", binding.native_path, ...piArgs, ...extra, "-p", text]);
    await piResume(piBinding, "Read the offline relay.");
    assert.match(JSON.stringify(requests.pi.at(-1).messages), /Codex answer 3\./);
    await wait(() => readDb(`SELECT 1 AS seen FROM turns WHERE origin_agent = 'pi' AND parent_turn_id = '${offHead.turn_id}'`),
      "Pi continues from the offline leaf");

    await exec(codex, ["exec", "--skip-git-repo-check", "Native paginated Codex thread."]);
    const native = await wait(() => readDb(`SELECT b.* FROM bindings b JOIN threads t ON b.thread_id = t.thread_id
      WHERE t.title = 'Native paginated Codex thread.' AND b.agent = 'codex'`), "native paginated thread");
    const mirroredPi = await wait(() => readDb(`SELECT * FROM bindings WHERE thread_id = '${native.thread_id}'
      AND agent = 'pi' AND mirror_pending = 0`), "Pi mirror of paginated Codex thread");
    await piResume(mirroredPi, "Pi paginated relay.");
    await wait(() => readDb(`SELECT 1 AS seen FROM turns WHERE thread_id = '${native.thread_id}' AND origin_agent = 'pi'`), "Pi paginated relay ingested");
    const original = await readFile(native.native_path);
    const progress = () => readDb(`SELECT * FROM bindings WHERE thread_id = '${native.thread_id}' AND agent = 'codex'`);
    await assert.rejects(offline(native, "codex"), /Codex CLI not found/);
    assert.deepEqual(await readFile(native.native_path), original);
    // Write a failing launcher only after the missing-CLI case, then replace it with the real launcher.
    await writeFile(projector, "process.exit(1);\n");
    await assert.rejects(offline(native, "codex"), /Codex projection interrupted/);
    const pending = progress();
    assert.equal(pending.projection_pending, 1);
    assert.notEqual(pending.last_written_turn_id, pending.last_timeline_turn_id);
    assert.equal(pending.last_seen_turn_id, pending.last_timeline_turn_id);
    await readCodex(1, native, true);
    await request(agentDir, "daemon-stop");
    await daemon.done;
    daemon = rpc(cli, ["daemon", "run"]);
    await wait(() => request(agentDir, "daemon-status").catch(() => null), "daemon ready after failed projection");
    const [commandPath, commandArgs] = commands(codex, []);
    await writeFile(projector, `const p = require('node:child_process').spawn(${JSON.stringify(commandPath)},
      ${JSON.stringify(commandArgs)}.concat(process.argv.slice(2)), { stdio: 'inherit' });
      p.on('exit', (code) => { process.exitCode = code ?? 1; });\n`);
    assert.equal((await offline(native, "codex")).appended_turns, 0);
    assert.equal(progress().projection_pending, 0);
    assert.equal(progress().last_timeline_turn_id, pending.last_written_turn_id);
    assert.equal(progress().last_seen_turn_id, pending.last_written_turn_id);
    assert.equal((await offline(native, "codex")).appended_turns, 0);
    assert.match(JSON.stringify(await readCodex(2, native, true)), /Pi paginated relay/);
    await piResume(mirroredPi, "Pi hook-only relay.");
    await wait(() => readDb(`SELECT 1 AS seen FROM threads WHERE thread_id = '${native.thread_id}' AND title = 'Native paginated Codex thread.'
      AND head_turn_id IN (SELECT turn_id FROM turns WHERE parent_turn_id IN (SELECT turn_id FROM turns WHERE thread_id = '${native.thread_id}' AND origin_agent = 'pi'))`), "Pi hook-only relay ingested");
    const piDelta = readDb(`SELECT head_turn_id AS turn_id FROM threads WHERE thread_id = '${native.thread_id}'`).turn_id;
    assert.equal(await request(agentDir, "codex-pull", JSON.stringify({ session: native.native_session_id,
      turn: "other-workspace", cwd: seed, path: native.native_path, deadline: Date.now() + 2000 })), null);
    await commit("Windows Codex should reread this file.\n");
    const command = `node "${join(agentDir, "launcher.cjs")}" hook CodexPrompt`;
    await writeFile(join(codexDir, "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command",
      command, timeout: 5, additionalContextLimit: 5000,
    }] }] } }));
    const startApp = async () => {
      const app = rpc(codex, ["app-server"]);
      const init = await app.call({ method: "initialize", params: { clientInfo: { name: "agent-link-test", version: "0.1.0" } } });
      assert.ok(init.result, JSON.stringify(init));
      app.send({ method: "initialized" });
      return app;
    };
    const review = await startApp();
    const listed = await review.call({ method: "hooks/list", params: { cwds: [workspace] } });
    review.child.stdin.end();
    const approved = listed.result?.data[0]?.hooks.find((h) => h.command === command && h.sourcePath === join(codexDir, "hooks.json"));
    assert.ok(approved?.currentHash, "Find the exact test Hook in the temporary Codex home");
    const config = join(codexDir, "config.toml");
    // Trust only the Hook written by this isolated test. Real installs must review it in /hooks.
    await writeFile(config, (await readFile(config, "utf8")) +
      `\n[hooks.state.${JSON.stringify(approved.key)}]\ntrusted_hash = ${JSON.stringify(approved.currentHash)}\n`);
    const online = await startApp();
    try {
      const resumed = await online.call({ method: "thread/resume", params: { threadId: native.native_session_id, excludeTurns: true } });
      assert.ok(resumed.result, JSON.stringify(resumed));
      const lockedBytes = await readFile(native.native_path);
      await assert.rejects(offline(native, "codex"), /Cannot acquire exclusive writer lease/);
      assert.deepEqual(await readFile(native.native_path), lockedBytes);
      const started = await online.call({ method: "turn/start", params: { threadId: native.native_session_id,
        input: [{ type: "text", text: "Use the Pi online handoff.", text_elements: [] }] } });
      assert.ok(started.result, JSON.stringify(started));
      await wait(() => online.events.find((event) => event.method === "turn/completed" &&
        event.params.turn.id === started.result.turn.id), "Codex online turn finished");
    } finally { online.child.stdin.end(); await online.done; }
    const payload = JSON.stringify(requests.codex.at(-1));
    assert.ok(payload.includes("<agent_link_history"), "Codex model request must contain Agent Link history");
    const injected = payload.slice(payload.lastIndexOf("<agent_link_history"));
    assert.ok(injected.includes("Pi hook-only relay."), "Codex model request must contain the pending Pi answer");
    assert.ok(!injected.includes("Pi paginated relay."), "Projected history must not be injected again");
    assert.ok(payload.includes("workspace_state_reset") && payload.includes("./tracked.txt"), "Codex receives committed-file drift");
    const accepted = await wait(() => readDb(`SELECT turn_id FROM turns WHERE thread_id = '${native.thread_id}'
      AND origin_agent = 'codex' AND parent_turn_id = '${piDelta}'`), "Codex acknowledged the delivered history");
    const state = readDb(`SELECT status, head_turn_id FROM threads WHERE thread_id = '${native.thread_id}'`);
    assert.equal(state.status, "SYNCED");
    assert.equal(state.head_turn_id, accepted.turn_id);
    assert.equal(readDb("SELECT count(*) AS n FROM codex_deliveries").n, 0);
    await readCodex(3, native, true);
    const hookOnly = progress();
    assert.equal(hookOnly.last_seen_turn_id, accepted.turn_id);
    assert.equal(hookOnly.last_timeline_turn_id, pending.last_written_turn_id);
    await request(agentDir, "daemon-stop");
    await daemon.done;
    environment.AGENT_LINK_CODEX_AUTO_SYNC = "1";
    const automatic = rpc(cli, ["daemon", "run"]);
    await wait(() => progress().last_timeline_turn_id === accepted.turn_id, "automatic backfill after lock release");
    assert.equal(progress().last_seen_turn_id, accepted.turn_id, "Backfill must not move model causality backwards");
    assert.match(JSON.stringify((await readCodex(4, native, true)).at(-1)), /Pi hook-only relay/);
    assert.equal(readDb(`SELECT count(*) AS n FROM turns WHERE thread_id = '${native.thread_id}'`).n, 4);
    await request(agentDir, "daemon-stop");
    await automatic.done;
    const beforeMigration = await stat(codexBinding.native_path);
    const migration = JSON.parse(await exec(codex, ["migrate-rollouts", "--apply", "--thread", codexBinding.native_session_id, "--json"]));
    const afterMigration = await stat(codexBinding.native_path);
    assert.equal(migration.outcomes[0].status, "migrated");
    assert.notEqual(afterMigration.ino, beforeMigration.ino, "Codex 0.158.0 migration replaces the rollout; do not reuse old offsets");
    environment.AGENT_LINK_CODEX_AUTO_SYNC = "0";
    daemon = rpc(cli, ["daemon", "run"]);
    await wait(() => request(agentDir, "daemon-status").catch(() => null), "daemon ready after rollout migration");
    const migratedBytes = await readFile(codexBinding.native_path);
    await assert.rejects(offline(codexBinding, "codex"), /Bound native file was replaced/);
    assert.deepEqual(await readFile(codexBinding.native_path), migratedBytes);
    console.log("Verified Windows: offline legacy/paginated append, crash-safe projection retry, real writer lock, automatic backfill and no duplicate Hook injection.");
    if (agy) {
      const agyPrompt = async (text, cont = false, cwd = workspace) => {
        const result = JSON.parse(await exec(agy, ["--print-timeout", "12s", "--output-format", "json",
          ...(cont ? ["--continue"] : []), "-p", text], cwd, agyEnvironment));
        assert.equal(result.status, "SUCCESS", JSON.stringify(result));
        return result;
      };
      await exec(pi, [...piArgs, "-p", "Three-client fixture seed."]);
      const relay = await wait(() => readDb("SELECT * FROM threads WHERE title = 'Three-client fixture seed.'"), "three-client seed");
      const state = () => readDb(`SELECT * FROM threads WHERE thread_id = '${relay.thread_id}'`);
      const binding = (agent) => readDb(`SELECT * FROM bindings WHERE thread_id = '${relay.thread_id}' AND agent = '${agent}' AND mirror_pending = 0`);
      const relayPi = binding("pi");
      const relayCodex = await wait(() => binding("codex"), "three-client Codex mirror");
      const codexResume = (text) => exec(codex, ["exec", "resume", "--skip-git-repo-check", relayCodex.native_session_id, text]);
      const since = async (parent, agent) => {
        const turn = await wait(() => readDb(`SELECT * FROM turns WHERE thread_id = '${relay.thread_id}'
          AND parent_turn_id = '${parent}' AND origin_agent = '${agent}'`), `${agent} continued the exact head`);
        assert.equal(state().status, "SYNCED");
        assert.equal(state().head_turn_id, turn.turn_id);
        return turn.turn_id;
      };
      const piAnswer = `Pi answer ${requests.pi.length}.`;
      agyWrite = true;
      const agyFirst = await agyPrompt(`#link ${relay.thread_id} Create the requested file.`);
      const agyAnswer = `Antigravity answer ${requests.agy.length}.`;
      assert.ok(agyFirst.response.includes(agyAnswer));
      const fromAgy = await since(relay.head_turn_id, "antigravity");
      assert.ok(JSON.stringify(requests.agy[0]).includes(piAnswer));
      const edit = await readFile(join(workspace, "agy-change.txt"), "utf8").catch(() => null);
      const declarations = requests.agy[0].tools?.flatMap((row) => row.functionDeclarations ?? row.function_declarations ?? []);
      assert.equal(edit, agyEdit, JSON.stringify({ tools: declarations?.map(({ name }) => name),
        write: declarations?.find(({ name }) => name === "write_file" || name === "write_to_file"), answer: agyFirst.response }));
      await exec("git", ["add", "agy-change.txt"]);
      await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
        "commit", "-qm", "Commit the Antigravity edit"]);
      await codexResume("Read the Antigravity conclusion.");
      const fromCodex = await since(fromAgy, "codex");
      const codexInput = JSON.stringify(requests.codex.at(-1));
      assert.ok(codexInput.includes(agyAnswer), "Codex must receive the Antigravity conclusion");
      assert.ok(codexInput.includes("workspace_state_reset") && codexInput.includes("./agy-change.txt"), "Codex must receive the committed Antigravity file drift");
      const codexAnswer = `Codex answer ${requests.codex.length}.`;
      await commit("Task 6 committed handoff fixture.\n");
      const agyBack = await agyPrompt("Continue from Codex in the original conversation.", true);
      assert.equal(agyBack.conversation_id, agyFirst.conversation_id);
      let head = await since(fromCodex, "antigravity");
      const agyInput = JSON.stringify(requests.agy.at(-1));
      assert.ok(agyInput.includes(codexAnswer) && agyInput.includes("workspace_state_reset") && agyInput.includes("./tracked.txt"));
      console.log("Verified Windows four-hop handoff: Pi → Antigravity → Codex → original Antigravity session, including a native edit and committed drift.");

      for (const operation of ["select", "merge"]) {
        await offline(relayPi, "pi");
        await offline(relayCodex, "codex");
        const hooks = join(codexDir, "hooks.json");
        const savedHooks = await readFile(hooks);
        await request(agentDir, "daemon-stop");
        await daemon.done;
        await writeFile(hooks, "{}");
        try {
          await piResume(relayPi, `Pi candidate ${operation}.`, "-ne");
          await codexResume(`Codex candidate ${operation}.`);
        } finally { await writeFile(hooks, savedHooks); }
        daemon = rpc(cli, ["daemon", "run"]);
        await wait(() => request(agentDir, "daemon-status").catch(() => null), "daemon ready after competing writes");
        await wait(() => state().status === "DIVERGED", "fork discovered");
        assert.equal(state().lca_turn_id, head);
        const winner = operation === "select" ? "codex" : "pi";
        const loser = winner === "pi" ? "codex" : "pi";
        const loserTurn = binding(loser).branch_head_turn_id;
        const winningTurn = binding(winner).branch_head_turn_id;
        const files = await Promise.all([relayPi, relayCodex].map((b) => readFile(b.native_path)));
        const argv = operation === "select" ? [winner] : ["--into", winner, "-m", "Use the green fixture conclusion."];
        const resolved = JSON.parse(await exec(cli, [operation, relay.thread_id, ...argv]));
        assert.equal(resolved.selected_turn_id, winningTurn);
        assert.equal(resolved.merge_parent_turn_id, operation === "merge" ? loserTurn : null);
        assert.ok(resolved.abandoned_turn_ids.includes(loserTurn));
        assert.equal(binding(loser).last_seen_turn_id, loserTurn);
        assert.deepEqual(await Promise.all([relayPi, relayCodex].map((b) => readFile(b.native_path))), files);
        head = resolved.head_turn_id;
        const note = operation === "merge" ? "Use the green fixture conclusion." : "分支裁决";
        if (loser === "pi") {
          await piResume(relayPi, "Continue Pi after selection.");
          head = await since(head, "pi");
          assert.ok(JSON.stringify(requests.pi.at(-1)).includes(note));
        } else {
          await codexResume("Continue Codex after merge.");
          head = await since(head, "codex");
          const input = JSON.stringify(requests.codex.at(-1));
          assert.ok(input.includes(note) && input.includes("workspace_state_reset"));
        }
        const nextAgy = await agyPrompt(`Continue Antigravity after ${operation}.`, true);
        assert.equal(nextAgy.conversation_id, agyFirst.conversation_id);
        head = await since(head, "antigravity");
        assert.ok(JSON.stringify(requests.agy.at(-1)).includes(note) && JSON.stringify(requests.agy.at(-1)).includes("workspace_state_reset"));
        await offline(winner === "pi" ? relayPi : relayCodex, winner);
        if (winner === "pi") {
          await piResume(relayPi, "Continue Pi from native merge history.");
          assert.ok(JSON.stringify(requests.pi.at(-1)).includes(note));
        } else {
          await codexResume("Continue Codex from native selection history.");
          assert.ok(JSON.stringify(requests.codex.at(-1)).includes(note));
        }
        head = await since(head, winner);
      }
      console.log(`Verified Windows select and merge: three native clients (Antigravity ${(await exec(agy, ["--version"], workspace, agyEnvironment)).trim()}) continued in the same logical thread after each resolution.`);
      await offline(relayPi, "pi");
      await offline(relayCodex, "codex");
      const files = [relayPi.native_path, relayCodex.native_path, binding("antigravity").native_path];
      files.push(files.at(-1).replace(/transcript\.jsonl$/, "transcript_full.jsonl"));
      const snapshot = () => Promise.all(files.map(async (path) => {
        const bytes = await readFile(path);
        return [bytes.length, createHash("sha256").update(bytes).digest("hex")];
      }));
      const expected = await snapshot();
      for (let i = 0; i < 3; i++) {
        await request(agentDir, "daemon-stop");
        await daemon.done;
        daemon = rpc(cli, ["daemon", "run"]);
        await wait(() => request(agentDir, "daemon-status").catch(() => null), "daemon ready for idempotence check");
        assert.equal((await offline(relayPi, "pi")).appended_turns, 0);
        assert.equal((await offline(relayCodex, "codex")).appended_turns, 0);
        assert.deepEqual(await snapshot(), expected);
      }
      await request(agentDir, "watch", seed);
      const outside = await agyPrompt(`#link ${relay.thread_id} Try a different workspace.`, false, seed);
      assert.notEqual(outside.conversation_id, agyFirst.conversation_id);
      assert.doesNotMatch(JSON.stringify(requests.agy.at(-1)), /<agent_link_history|Three-client fixture seed|Use the green fixture conclusion/);
      assert.equal(binding("antigravity").native_session_id, agyFirst.conversation_id);
      console.log("Verified publication checks: three restarts with identical three-client files, no-op manual sync, and real cross-workspace #link rejection.");
    }
  }
  if (daemon.child.exitCode === null) {
    await request(agentDir, "daemon-stop");
    await daemon.done;
  }
  console.log("Verified: Pi -> Codex thread/list + thread/read (1 turn), real Codex continuation (2 turns), Pi live injection, persisted parent, /sync, no echo.");
} finally {
  mock.close();
  for (const { child, done } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await Promise.race([done, delay(300)]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await done;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
