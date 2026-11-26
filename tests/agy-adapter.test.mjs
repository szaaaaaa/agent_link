import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agyInjection, defaultAgyReply, isNormalAgyStop, parseAgyHook, readAgyTranscript } from "../dist/adapters/agy-adapter.js";
import { sanitizeTurn } from "../dist/core/sanitizer.js";
import { normalizeWorkspace, resolveWorkspace } from "../dist/core/workspace.js";

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "al-agy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const fixture = (name) => readFileSync(new URL(`./fixtures/agy-2.0/${name}.jsonl`, import.meta.url), "utf8");
async function read(path, cursor) {
  const turns = [];
  for await (const turn of readAgyTranscript(path, cursor)) turns.push(turn);
  return turns;
}

function writeSamples(dir, primary = fixture("transcript"), full = fixture("transcript_full")) {
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, primary);
  if (full !== null) writeFileSync(join(dir, "transcript_full.jsonl"), full);
  return path;
}

test("Antigravity Hook wire shape preserves all workspace candidates and fails open by event", (t) => {
  const cwd = sandbox(t);
  const input = { conversationId: "fixture", workspacePaths: [join(cwd, "other"), cwd, null], cwd,
    transcriptPath: join(cwd, "transcript.jsonl"), lastUserInput: "#link latest", invocationNum: 3, initialNumSteps: 10 };
  const hook = parseAgyHook("PreInvocation", { ...input, hookEventName: "PreInvocation" });
  assert.equal(resolveWorkspace(hook.candidates, new Set([normalizeWorkspace(cwd)])), normalizeWorkspace(cwd));
  assert.equal(hook.candidates.length, 3);
  assert.equal(hook.invocationNum, 3);
  assert.equal(hook.initialNumSteps, 10);
  assert.equal(parseAgyHook("PreInvocation", { ...input, invocationNum: -1 }).invocationNum, undefined);
  assert.equal(parseAgyHook("PreInvocation", { ...input, hookEventName: "Stop" }), null);
  assert.equal(parseAgyHook("Stop", { ...input, transcriptPath: join(cwd, "conversation.pb"), terminationReason: "NO_TOOL_CALL" }), null);
  const cliStop = parseAgyHook("Stop", { ...input, transcriptPath: join(cwd, "transcript_full.jsonl"), terminationReason: "NO_TOOL_CALL" });
  assert.equal(cliStop.transcriptPath, input.transcriptPath);
  for (const reason of ["NO_TOOL_CALL", "model_stop", "USER_CANCELED", "MAX_INVOCATIONS", "ERROR"]) {
    assert.equal(isNormalAgyStop(parseAgyHook("Stop", { ...input, terminationReason: reason })),
      reason === "NO_TOOL_CALL" || reason === "model_stop");
  }
  assert.deepEqual(defaultAgyReply("Stop"), { decision: "stop" });
  assert.deepEqual(defaultAgyReply("SessionStart"), {});
  assert.deepEqual(defaultAgyReply("PreInvocation"), {});
  assert.deepEqual(agyInjection("", "Pick a session"), {
    injectSteps: [{ systemMessage: { systemMessage: "", metadata: { user_markdown: "Pick a session" } } }],
  });
});

test("native transcript shape yields visible turns only, restoring long fields by step index", async (t) => {
  const dir = sandbox(t);
  const path = writeSamples(dir);
  const [first, second, ...rest] = await read(path);
  assert.deepEqual(rest, []);
  assert.deepEqual([first.anchor, first.lastStep, first.userText, first.assistantText],
    ["0", 32, "Sample question.", "First reply restored from full transcript."]);
  assert.deepEqual([second.anchor, second.lastStep, second.userText, second.assistantText],
    ["33", 38, "#link latest Expanded user question 雪.", "Second reply restored from full transcript."]);
  const cleaned = sanitizeTurn(first, normalizeWorkspace(dir));
  assert.deepEqual(cleaned.tool_digest, ["cmd `npm test` -> exit unknown"]);
  assert.doesNotMatch(JSON.stringify([first, second]), /Excluded/);
  assert.equal(sanitizeTurn(second, normalizeWorkspace(dir)).user_text, "Expanded user question 雪.");
  assert.ok(first.cursor.fullByteOffset > 0);
  assert.ok(first.cursor.fullByteOffset < second.cursor.fullByteOffset);
  assert.deepEqual(await read(path, first.cursor), [second]);
  assert.deepEqual(await read(path, second.cursor), []);
});

test("missing or incomplete transcript data never advances the affected turn", async (t) => {
  const dir = sandbox(t);
  const primary = fixture("transcript");
  const full = fixture("transcript_full");
  const path = writeSamples(dir, primary, null);
  assert.deepEqual(await read(path), []);
  const fullPath = join(dir, "transcript_full.jsonl");
  writeFileSync(fullPath, full.slice(0, -1));
  const [first, ...pending] = await read(path);
  assert.equal(first.anchor, "0");
  assert.deepEqual(pending, []);
  assert.ok(first.cursor.byteOffset < Buffer.byteLength(primary));
  appendFileSync(fullPath, "\n");
  writeFileSync(path, primary.slice(0, -1));
  assert.deepEqual(await read(path, first.cursor), []);
  appendFileSync(path, "\n");
  const [second] = await read(path, first.cursor);
  assert.equal(second.cursor.byteOffset, Buffer.byteLength(primary));
  assert.equal(second.cursor.fullByteOffset, Buffer.byteLength(full));
});

test("the last visible planner response wins, and irrelevant truncated fields need no full file", async (t) => {
  const dir = sandbox(t);
  const primary = [
    { step_index: 5, type: "USER_INPUT", status: "DONE", content: "Plain question" },
    { step_index: 6, type: "PLANNER_RESPONSE", status: "DONE", content: "Intermediate text", truncated_fields: ["thinking"] },
    { step_index: 7, type: "PLANNER_RESPONSE", status: "DONE", content: "Final answer" },
    { step_index: 8, type: "PLANNER_RESPONSE", status: "ERROR", content: "Not a reply" },
  ].map(JSON.stringify).join("\n") + "\n";
  const path = writeSamples(dir, primary, null);
  const [turn] = await read(path);
  assert.equal(turn.assistantText, "Final answer");
  assert.equal(turn.cursor.fullByteOffset, 0);
  await assert.rejects(read(join(dir, "conversation.pb")), /Expected an absolute transcript\.jsonl path/);
  writeFileSync(path, primary + '{"private":"do not leak"\n');
  await assert.rejects(read(path, turn.cursor), (error) =>
    /Invalid Antigravity transcript step at byte/.test(error.message) && !error.message.includes("do not leak"));
});
