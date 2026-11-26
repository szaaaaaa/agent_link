import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { codexHeader, codexReader, createCodexSession, encodeCodexTurn, registerCodexSession } from "../dist/adapters/codex-adapter.js";
import { createPiSession, encodePiTurn, piHeader, piParent, piReader, piSessionDir } from "../dist/adapters/pi-adapter.js";

const fixture = (agent) => readFileSync(new URL(`./fixtures/${agent}-native.jsonl`, import.meta.url), "utf8").trimEnd().split("\n");
const shared = { turn_id: "tu_01", user_text: "Mirrored question?", assistant_text: "Mirrored answer.",
  tool_digest: ["cmd `npm test` -> exit 0"], created_at: 1795571462000 };
const sandbox = (t) => {
  const path = mkdtempSync(join(tmpdir(), "al-native-"));
  t.after(() => rmSync(path, { recursive: true, force: true, maxRetries: 3 }));
  return path;
};

test("Pi native sample emits one closed turn and resolves the actual branch", () => {
  const rows = fixture("pi");
  assert.equal(piHeader(rows[0]).cwd, "C:\\fixture\\work");
  const anchors = new Map();
  const parse = piReader((id) => piParent(id, (key) => anchors.get(key)), (entry) => {
    anchors.set(entry.id, { parentId: entry.parentId, turnId: entry.details?.turnId });
  });
  const results = rows.map(parse).filter(Boolean);
  assert.deepEqual(results, [{ anchor: "72cd58c3", parentTurnId: null, userText: "Sample question.",
    assistantText: "Sample reply.", tools: [] }]);
  const projected = encodePiTurn(shared, "72cd58c3").trimEnd().split("\n");
  assert.deepEqual(projected.map(parse), [null, null]);

  const user = JSON.parse(rows.at(-2));
  const answer = JSON.parse(rows.at(-1));
  user.id = "user2";
  user.parentId = "al_tu_01_a";
  assert.equal(parse(JSON.stringify(user)), undefined);
  parse(JSON.stringify({ type: "custom_message", customType: "agent-link", id: "injected", parentId: user.id,
    details: { turnId: "tu_02" } }));
  answer.id = "answer2";
  answer.parentId = "injected";
  assert.equal(parse(JSON.stringify(answer)).parentTurnId, "tu_02");
  assert.equal(piParent(user.id, (key) => anchors.get(key)), "tu_01");
  assert.throws(() => piParent("missing", () => undefined), /Missing Pi parent entry/);
});

test("Pi creates a v3 session in the client-compatible directory, with deterministic mirror entries", async (t) => {
  const root = sandbox(t);
  const cwd = process.platform === "win32" ? "D:\\Repo\\My Work" : "/repo/my work";
  const encoded = process.platform === "win32" ? "--D--Repo-My Work--" : "--repo-my work--";
  assert.equal(piSessionDir(root, cwd), join(root, encoded));
  const session = await createPiSession(root, cwd);
  appendFileSync(session.path, encodePiTurn(shared, null));
  const [header, user, assistant] = readFileSync(session.path, "utf8").trimEnd().split("\n").map(JSON.parse);
  assert.equal(header.version, 3);
  assert.equal(header.id, session.id);
  assert.equal(user.id, "al_tu_01_u");
  assert.equal(assistant.parentId, user.id);
  assert.match(assistant.message.content[0].text, /exit 0/);
});

test("Codex CLI 0.158 sample closes on task_complete, ignores duplicate response items and excludes subagents", () => {
  const rows = fixture("codex");
  const header = JSON.parse(rows[0]);
  assert.equal(codexHeader(rows[0]).id, header.payload.id);
  for (const payload of [{ source: { subagent: { thread_spawn: {} } } }, { session_id: "other" },
    { parent_thread_id: "other" }, { thread_source: "sub_agent" }]) {
    assert.equal(codexHeader(JSON.stringify({ ...header, payload: { ...header.payload, ...payload } })), null);
  }
  const parse = codexReader(() => "tu_00");
  assert.equal(rows.slice(0, -1).map(parse).filter(Boolean).length, 0);
  assert.deepEqual(parse(rows.at(-1)), { anchor: JSON.parse(rows.at(-1)).payload.turn_id,
    parentTurnId: "tu_00", userText: "Sample question.", assistantText: "Sample reply.", tools: [] });
  const legacy = rows.filter((line) => JSON.parse(line).payload?.type !== "item_completed");
  assert.deepEqual(legacy.map(codexReader(() => null)).filter(Boolean), []);

  const projected = encodeCodexTurn(shared, { cwd: "C:\\fixture\\work", model: "gpt-5", ordinal: 12 });
  const lines = projected.trimEnd().split("\n");
  assert.deepEqual(lines.map((line) => JSON.parse(line).ordinal), [13, 14, 15, 16, 17, 18, 19]);
  assert.deepEqual(lines.map(codexReader(() => null)).filter(Boolean), []);
  assert.doesNotMatch(projected, /encrypted_content|function_call/);
  const nativeLegacy = projected.replaceAll("<!-- agent-link:tu_01 -->", "");
  assert.equal(nativeLegacy.trimEnd().split("\n").map(codexReader(() => null)).filter(Boolean)[0].userText, shared.user_text);
});

test("Codex paginated projection emits a complete ordinal sequence without echo", () => {
  const session = { cwd: "C:/fixture/work", model: "gpt-5", id: "thread-1", ordinal: 40, historyMode: "paginated" };
  const lines = encodeCodexTurn(shared, session).trimEnd().split("\n");
  const rows = lines.map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.ordinal), [41, 42, 43, 44, 45, 46, 47]);
  const items = rows.filter((row) => row.payload.type === "item_completed").map((row) => row.payload);
  assert.deepEqual(items.map(({ item }) => item.type), ["UserMessage", "AgentMessage"]);
  assert.ok(items.every((item) => item.thread_id === session.id && item.turn_id === rows.at(-1).payload.turn_id &&
    item.item.id && Number.isSafeInteger(item.completed_at_ms)));
  assert.equal(new Set(items.map(({ item }) => item.id)).size, 2);
  assert.deepEqual(lines.map(codexReader(() => null)).filter(Boolean), []);
  assert.throws(() => encodeCodexTurn(shared, { ...session, ordinal: undefined }), /valid ordinal/);
});

test("Codex acknowledges a matching native developer delivery, never a marker in user text", () => {
  const rows = fixture("codex");
  const complete = JSON.parse(rows.at(-1));
  const id = complete.payload.turn_id;
  const token = "a".repeat(32);
  const context = (role, marker) => JSON.stringify({ type: "response_item", payload: { type: "message", role,
    content: [{ type: "input_text", text: `A copied history <!-- agent-link-delivery:${marker} -->` }] } });
  const parse = () => codexReader(() => "tu_old", (turn, marker) => turn === id && marker === token ? "tu_seen" : null);
  for (const [role, marker, expected] of [["developer", token, "tu_seen"], ["user", token, "tu_old"],
    ["developer", "b".repeat(32), "tu_old"]]) {
    const turns = [...rows.slice(0, -1), context(role, marker), rows.at(-1)].map(parse()).filter(Boolean);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].parentTurnId, expected);
    assert.equal(turns[0].userText, "Sample question.");
    assert.equal(turns[0].assistantText, "Sample reply.");
  }
});

test("Codex registration uses the workspace template or returns a resume hint without changing the rollout", async (t) => {
  const home = sandbox(t);
  const session = await createCodexSession(home, home, "fixture", "gpt-5", "0.158.0");
  const path = join(home, "state_5.sqlite");
  const original = readFileSync(session.path, "utf8");
  assert.equal(registerCodexSession(home, session, "Fixture"), `codex resume ${session.id}`);
  assert.equal(readFileSync(session.path, "utf8"), original);
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL,
      title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model_provider TEXT NOT NULL,
      "extra column" TEXT NOT NULL, extra_number INT NOT NULL DEFAULT 42);
      INSERT INTO threads VALUES ('fallback', 'fallback.jsonl', 'elsewhere', 'fallback', 0, 9, 'provider', 'elsewhere', 43);`);
    db.prepare("INSERT INTO threads VALUES ('same', 'same.jsonl', ?, 'same', 0, 1, 'provider', 'same workspace', 44)").run(home);
    assert.equal(registerCodexSession(home, session, "Fixture"), null);
    const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(session.id);
    assert.equal(row.rollout_path, session.path);
    assert.equal(row.title, "[Sync] Fixture");
    assert.equal(row.model_provider, "fixture");
    assert.equal(row["extra column"], "same workspace");
    assert.equal(row.extra_number, 42);
    assert.equal(registerCodexSession(home, session, "Fixture"), null);
    assert.equal(registerCodexSession(home, { ...session, path: "wrong.jsonl" }, "Fixture"), `codex resume ${session.id}`);
  } finally { db.close(); }
});
