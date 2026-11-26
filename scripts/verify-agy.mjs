// npm run build; AGY_CLI=/absolute/path/to/agy node scripts/verify-agy.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const agy = process.env.AGY_CLI;
assert.ok(agy && isAbsolute(agy), "Set AGY_CLI to the absolute path of the official executable");
const exec = promisify(execFile);
const node = process.execPath;
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const probe = fileURLToPath(new URL("./probe-agy.mjs", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "agent-link-cli-"));
const home = join(root, "home");
const dir = join(root, "state");
let workspace;
let toolTurn = false;
const fixtureAnswer = "CLI first answer. " + "abcdef ".repeat(800) + "CLI reply complete.";
const observed = [];
const mock = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!req.url?.includes("streamGenerateContent")) { res.writeHead(404).end(); return; }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const text = JSON.stringify(input);
  const tools = input.tools?.flatMap((row) => row.functionDeclarations ?? row.function_declarations ?? []) ?? [];
  const read = toolTurn && !observed.some((row) => row.tool) && tools.find((tool) => tool.name === "read_file");
  observed.push({ marker: text.includes("indigo lantern 407"), history: text.includes("<agent_link_history"),
    tool: !!read, conclusion: text.includes("CLI reply complete.") });
  const part = read ? { functionCall: { name: read.name, args: { Path: join(workspace, "sample.txt") } } }
    : { text: observed.length === 1 ? fixtureAnswer : "Fixture answer." };
  const sse = { candidates: [{ index: 0, content: { role: "model", parts: [part] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end("data: " + JSON.stringify(sse) + "\n\n");
});

const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(root, "appdata"),
  LOCALAPPDATA: join(root, "local"), AGENT_LINK_HOME: dir, AGENT_LINK_AGY_FIRST_INVOCATION: "0",
  PI_CODING_AGENT_DIR: join(root, "pi"), PI_CODING_AGENT_SESSION_DIR: join(root, "pi", "sessions"),
  CODEX_HOME: join(root, "codex"), GEMINI_API_KEY: "dummy-fixture" };
const run = (exe, args) => exec(exe, args, { env, cwd: workspace, timeout: 20_000, windowsHide: true });
const agentLink = async (...args) => JSON.parse((await run(node, [cli, ...args])).stdout);
const prompt = async (text, cont = false) => JSON.parse((await run(agy, ["--print-timeout", "12s", "--output-format", "json",
  ...(cont ? ["--continue"] : []), "-p", text])).stdout);
async function until(fn) {
  for (let i = 0; i < 60; i++) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw new Error("Agent Link did not persist the expected Antigravity turn");
}

try {
  const settings = join(home, ".gemini", "antigravity-cli");
  await mkdir(settings, { recursive: true });
  await writeFile(join(settings, "settings.json"), JSON.stringify({ modelProvider: "gemini", agentMode: "", toolPermission: "request-review" }));
  workspace = (await run(node, [probe, "prepare"])).stdout.trim();
  await writeFile(join(workspace, "sample.txt"), "A read-only fixture.\n");
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
  await agentLink("install");
  await agentLink("watch", workspace);
  const version = (await run(agy, ["--version"])).stdout.trim();
  const first = await prompt("CLI fixture first question.");
  assert.equal(first.status, "SUCCESS");
  assert.doesNotMatch(first.response, /indigo lantern 407/);
  const thread = await until(async () => (await agentLink("status", workspace)).threads.find((row) =>
    row.title === "CLI fixture first question." && row.bindings.some((binding) => binding.agent === "antigravity")));
  const saved = await readFile(join(dir, "turns", thread.thread_id + ".jsonl"), "utf8");
  assert.equal(JSON.parse(saved.trim()).assistant_text.trim(), fixtureAnswer);
  const transcript = join(home, ".gemini", "antigravity-cli", "brain", first.conversation_id,
    ".system_generated", "logs", "transcript.jsonl");
  const primary = (await readFile(transcript, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(primary.some((row) => row.type === "PLANNER_RESPONSE" && row.truncated_fields?.includes("content")),
    "The CLI fixture must actually exercise the truncated primary file");

  toolTurn = true;
  const second = await prompt("AGY_FIXTURE_READ Read sample.txt then summarize it.", true);
  toolTurn = false;
  assert.equal(second.conversation_id, first.conversation_id);
  await until(async () => {
    const rows = (await agentLink("status", workspace)).threads;
    return rows[0]?.thread_id === thread.thread_id && rows[0].head_turn_id !== thread.head_turn_id;
  });
  const linked = await prompt("#link " + thread.thread_id);
  assert.equal(linked.status, "SUCCESS");
  assert.notEqual(linked.conversation_id, first.conversation_id);
  assert.equal(observed.filter((row) => row.tool).length, 1);
  assert.ok(observed.length >= 4);
  assert.equal(observed[0].history, false);
  assert.equal(observed.at(-1).history, true);
  assert.equal(observed.at(-1).conclusion, true);
  assert.ok(observed.every((row) => !row.marker));
  const events = (await readFile(join(workspace, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.filter((row) => row.event === "PreInvocation").map((row) => row.invocationNum), [0, 0, 1, 0]);
  assert.deepEqual(events.filter((row) => row.event === "Stop").map((row) => row.terminationReason), Array(3).fill("NO_TOOL_CALL"));
  assert.ok(events.every((row) => row.transcriptFile === "full"));
  const logDir = join(settings, "log");
  const logs = (await Promise.all((await readdir(logDir)).filter((name) => name.endsWith(".log"))
    .map((name) => readFile(join(logDir, name), "utf8")))).join("\n");
  assert.match(logs, /jsonhook__agent-link-probe_SessionStart[^\n]*type mismatch/);
  assert.doesNotMatch(logs, /jsonhook__agent-link_(?:SessionStart|PreInvocation)[^\n]*panicked/);
  const latest = await until(async () => {
    const rows = (await agentLink("status", workspace)).threads;
    return rows.length === 1 && rows[0].bindings.some((b) => b.native_session_id === linked.conversation_id) &&
      (await readFile(join(dir, "turns", thread.thread_id + ".jsonl"), "utf8")).trim().split("\n").length === 3 ? rows[0] : null;
  });
  assert.equal(latest.status, "SYNCED");
  console.log(`Verified Antigravity CLI ${version}: real Stop ingestion, full answer recovery, invocation 0/1, and #link history in the model request.`);
} finally {
  mock.close();
  if (workspace) {
    await agentLink("daemon", "stop").catch(() => {});
    await rm(workspace, { force: true, recursive: true, maxRetries: 4 });
  }
  await rm(root, { force: true, recursive: true, maxRetries: 4 });
}
