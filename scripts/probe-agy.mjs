// npm run build; node scripts/probe-agy.mjs prepare
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agyHookCommand } from "../dist/install.js";

const events = ["SessionStart", "PreInvocation", "Stop"];
const marker = "Agent Link UI probe: indigo lantern 407.";
const reasons = new Set(["NO_TOOL_CALL", "model_stop", "MAX_INVOCATIONS", "MAX_FORCED_INVOCATIONS",
  "MAX_TOKEN_BUDGET_EXCEEDED", "ERROR", "USER_CANCELED", "TERMINAL_STEP_TYPE", "TERMINAL_CUSTOM_HOOK", "INJECTED_RESPONSE"]);
const [command, event] = process.argv.slice(2);
if (command === "prepare") {
  const root = await mkdtemp(join(tmpdir(), "agent-link-agy-probe-"));
  const agents = join(root, ".agents");
  await mkdir(agents);
  const source = fileURLToPath(import.meta.url);
  const hooks = Object.fromEntries(events.map((name) => [name, [{ type: "command",
    command: agyHookCommand(process.execPath, source, name), timeout: 5 }]]));
  await writeFile(join(agents, "hooks.json"), JSON.stringify({ "agent-link-probe": hooks }, null, 2) + "\n", { flag: "wx" });
  console.log(root);
} else if (command === "hook" && events.includes(event)) {
  const cwd = process.cwd();
  const root = dirname(cwd);
  const fallback = event === "Stop" ? { decision: "stop" } : {};
  let reply = fallback;
  try {
    if (basename(cwd) !== ".agents" || !basename(root).startsWith("agent-link-agy-probe-")) throw new Error("Outside probe sandbox");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      if ((bytes += chunk.length) > 1024 * 1024) throw new Error("Oversize payload");
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const row = { event };
    for (const key of ["invocationNum", "initialNumSteps", "executionNum"]) {
      row[key] = Number.isSafeInteger(input[key]) ? input[key] : null;
    }
    if (event === "Stop") row.terminationReason = reasons.has(input.terminationReason) ? input.terminationReason : null;
    const path = input.transcriptPath;
    const name = typeof path === "string" ? basename(path) : "";
    row.transcriptJsonl = name === "transcript.jsonl";
    row.transcriptFile = name === "transcript.jsonl" ? "primary" : name === "transcript_full.jsonl" ? "full"
      : name ? "other" : "missing";
    await appendFile(join(root, "events.jsonl"), JSON.stringify(row) + "\n", { mode: 0o600 });
    if (event === "SessionStart") reply = { injectSteps: [{ systemMessage: { systemMessage: "",
      metadata: { user_markdown: marker } } }] };
  } catch { /* Do not put probe errors or raw Hook payloads on stdout. */ }
  console.log(JSON.stringify(reply));
} else {
  console.error("Usage: node scripts/probe-agy.mjs prepare");
  process.exitCode = 1;
}
