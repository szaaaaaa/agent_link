import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStateDb } from "../dist/core/db.js";
import { Engine } from "../dist/core/engine.js";
import { normalizeWorkspace } from "../dist/core/workspace.js";

const adapter = {
  reader(binding) {
    return (text) => {
      if (text === null) return null;
      const row = JSON.parse(text);
      if (row.turn) return null;
      return { anchor: row.anchor, userText: row.anchor, assistantText: row.answer, tools: [],
        parentTurnId: row.parent === undefined ? binding.last_written_turn_id : row.parent };
    };
  },
  withWritable: async (_binding, run) => run(),
  encode: (turn) => JSON.stringify({ turn: turn.turn_id, user: turn.user_text }) + "\n",
};

function fixture(t, adapters = { pi: adapter, codex: adapter }) {
  const dir = mkdtempSync(join(tmpdir(), "agent-link-engine-"));
  const db = openStateDb(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = normalizeWorkspace(dir);
  db.prepare("INSERT INTO workspaces VALUES (?, ?, 1, 0)").run(key, dir);
  db.prepare("INSERT INTO threads (thread_id, workspace_key, title, created_at, updated_at) VALUES ('th_one', ?, 'Test', 0, 0)").run(key);
  const path = { pi: join(dir, "pi.jsonl"), codex: join(dir, "codex.jsonl") };
  for (const agent of Object.keys(path)) {
    writeFileSync(path[agent], "");
    db.prepare(`INSERT INTO bindings (thread_id, agent, native_session_id, native_path, updated_at)
      VALUES ('th_one', ?, ?, ?, 0)`).run(agent, agent, path[agent]);
  }
  const warnings = [];
  const engine = new Engine(db, dir, adapters, () => 1000, (message) => warnings.push(message));
  return { dir, db, engine, path, warnings };
}

function add(path, anchor, parent) {
  appendFileSync(path, JSON.stringify({ anchor, answer: "answer " + anchor, parent }) + "\n");
}
const thread = (db) => db.prepare("SELECT * FROM threads").get();
const binding = (db, agent) => db.prepare("SELECT * FROM bindings WHERE agent = ?").get(agent);
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

for (const race of [false, true]) {
  test(race ? "a native turn written after phase one is drained before append" : "two stopped clients fork at their common baseline without outbound writes", async (t) => {
    let beforeWrite;
    const { db, engine, path, warnings } = fixture(t, { pi: adapter, codex: {
      ...adapter, withWritable: async (b, run) => {
        const before = beforeWrite;
        beforeWrite = undefined;
        before?.();
        await adapter.withWritable(b, run);
      },
    } });
    try {
      add(path.pi, "root");
      await engine.sync();
      const root = thread(db).head_turn_id;
      add(path.pi, "pi branch", root);
      const competing = () => add(path.codex, "codex branch", root);
      if (race) beforeWrite = competing;
      else competing();
      await Promise.all([engine.sync(), engine.sync()]);
      assert.equal(thread(db).status, "DIVERGED");
      assert.equal(thread(db).lca_turn_id, root);
      assert.equal(count(db, "turns"), 3);
      assert.notEqual(binding(db, "pi").branch_head_turn_id, binding(db, "codex").branch_head_turn_id);
      assert.equal(count(db, "native_writes"), 1);
      assert.match(readFileSync(path.pi, "utf8"), /pi branch/);
      assert.match(readFileSync(path.codex, "utf8"), /codex branch/);
      assert.deepEqual(warnings, []);
    } finally { db.close(); }
  });
}

for (const action of ["select", "merge"]) {
  test(`${action} preserves both branches and rejoins three clients only after delivery`, async (t) => {
    const { dir, db, engine, path } = fixture(t, { pi: adapter, codex: adapter, antigravity: adapter });
    path.antigravity = join(dir, "antigravity.jsonl");
    writeFileSync(path.antigravity, "");
    db.prepare(`INSERT INTO bindings (thread_id, agent, native_session_id, native_path, updated_at)
      VALUES ('th_one', 'antigravity', 'agy', ?, 0)`).run(path.antigravity);
    try {
      add(path.pi, "root");
      await engine.sync();
      const root = thread(db).head_turn_id;
      add(path.pi, "winner", root);
      add(path.codex, "loser", root);
      await engine.sync();
      const winner = binding(db, "pi").branch_head_turn_id;
      const loser = binding(db, "codex").branch_head_turn_id;
      const bytes = Object.fromEntries(Object.entries(path).map(([agent, file]) => [agent, readFileSync(file, "utf8")]));
      const decision = await engine.resolveFork("th_one", "pi", action === "merge" ? "Use both verified findings" : undefined);
      assert.equal(decision.selected_turn_id, winner);
      assert.equal(thread(db).status, "SYNCED");
      assert.equal(thread(db).head_turn_id, decision.head_turn_id);
      assert.equal(binding(db, "codex").last_seen_turn_id, loser);
      assert.equal(binding(db, "antigravity").last_seen_turn_id, root);
      assert.deepEqual(Object.keys(bytes).map((agent) => readFileSync(path[agent], "utf8")), Object.values(bytes));
      assert.equal((await engine.readTurn("th_one", loser)).assistant_text, "answer loser");
      assert.deepEqual(db.prepare("SELECT state, parent_turn_id FROM turns WHERE turn_id = ?").get(loser),
        Object.assign(Object.create(null), { state: "abandoned", parent_turn_id: root }));
      const row = db.prepare("SELECT parent_turn_id, merge_parent_turn_id FROM turns WHERE turn_id = ?").get(decision.head_turn_id);
      assert.equal(row.parent_turn_id, winner);
      assert.equal(row.merge_parent_turn_id, action === "merge" ? loser : null);
      assert.deepEqual(engine.deliveryUnread("th_one", loser), [winner, decision.head_turn_id]);
      const context = await engine.deliveryContext("th_one", engine.deliveryUnread("th_one", loser), "");
      assert.match(context.state, /重新读取相关文件/);
      assert.match(context.turns.at(-1).user_text, /winner[\s\S]+loser/);
      if (action === "merge") assert.match(context.turns.at(-1).assistant_text, /Use both verified findings/);
      await engine.sync();
      const continued = new Engine(db, dir, { pi: adapter, codex: adapter, antigravity: adapter });
      for (const agent of Object.keys(path)) {
        assert.ok(readFileSync(path[agent], "utf8").startsWith(bytes[agent]));
        assert.equal(binding(db, agent).last_seen_turn_id, thread(db).head_turn_id);
        add(path[agent], `after ${agent}`);
        await continued.sync();
        assert.equal(thread(db).status, "SYNCED");
      }
      assert.equal(count(db, "turns"), 7);
      await assert.rejects(continued.resolveFork("th_one", "pi"), /not DIVERGED/);
    } finally { db.close(); }
  });
}

test("resolution rejects incomplete native data and preserves a later turn from an unnotified branch", async (t) => {
  const readOnly = { reader: adapter.reader };
  const { db, engine, path } = fixture(t, { pi: readOnly, codex: readOnly });
  try {
    add(path.pi, "pi branch", null);
    add(path.codex, "codex branch", null);
    await engine.sync();
    const loser = binding(db, "codex").branch_head_turn_id;
    appendFileSync(path.pi, '{"anchor":"late');
    await assert.rejects(engine.resolveFork("th_one", "pi"), /open turn/);
    assert.equal(thread(db).status, "DIVERGED");
    appendFileSync(path.pi, '","answer":"native latest"}\n');
    const decision = await engine.resolveFork("th_one", "pi");
    assert.equal((await engine.readTurn("th_one", decision.selected_turn_id)).assistant_text, "native latest");
    add(path.codex, "still on old branch", loser);
    await engine.sync();
    assert.equal(thread(db).status, "DIVERGED");
    assert.equal(db.prepare("SELECT parent_turn_id FROM turns WHERE turn_id = ?").get(binding(db, "codex").branch_head_turn_id).parent_turn_id, loser);
  } finally { db.close(); }
});

test("a native half-line does not advance the cursor or get overwritten", async (t) => {
  const { db, engine, path, warnings } = fixture(t);
  try {
    appendFileSync(path.codex, '{"anchor":"half');
    add(path.pi, "first");
    await engine.sync();
    assert.equal(binding(db, "codex").last_byte_offset, 0);
    assert.equal(readFileSync(path.codex, "utf8"), '{"anchor":"half');
    assert.equal(count(db, "native_writes"), 0);
    appendFileSync(path.codex, '","answer":"done"}\n');
    await engine.sync();
    assert.equal(binding(db, "codex").last_byte_offset, statSync(path.codex).size);
    assert.equal(count(db, "turns"), 2);
    assert.equal(thread(db).status, "DIVERGED");
    assert.deepEqual(warnings, []);
  } finally { db.close(); }
});

test("durable ledger recovers after append/commit failure and three restarts do not echo", async (t) => {
  const { dir, db, engine, path, warnings } = fixture(t);
  try {
    const backups = join(dir, "backups");
    mkdirSync(backups);
    const old = join(backups, "0-deadbeef.bak");
    writeFileSync(old, "");
    truncateSync(old, 100_000_000);
    db.exec(`CREATE TRIGGER fail_commit BEFORE UPDATE OF status ON native_writes BEGIN
      SELECT RAISE(ABORT, 'simulated lost cursor commit'); END`);
    add(path.pi, "first");
    await engine.sync();
    assert.match(warnings.join(), /simulated lost cursor commit/);
    assert.equal(binding(db, "codex").last_byte_offset, 0);
    assert.ok(statSync(path.codex).size > 0);
    assert.equal(db.prepare("SELECT status FROM native_writes").get().status, "pending");
    const files = readdirSync(backups);
    assert.equal(files.length, 1);
    assert.notEqual(files[0], "0-deadbeef.bak");
    assert.ok(files.reduce((total, name) => total + statSync(join(backups, name)).size, 0) <= 100_000_000);
    assert.equal(JSON.parse(readFileSync(join(backups, files[0]), "utf8")).offset, 0);
    db.exec("DROP TRIGGER fail_commit");
  } finally { db.close(); }
  const expected = [digest(path.pi), digest(path.codex)];
  for (let i = 0; i < 3; i++) {
    const reopened = openStateDb(dir);
    try {
      await new Engine(reopened, dir, { pi: adapter, codex: adapter }).sync();
      assert.equal(count(reopened, "turns"), 1);
      assert.equal(reopened.prepare("SELECT status FROM native_writes").get().status, "done");
      assert.equal(binding(reopened, "codex").last_byte_offset, statSync(path.codex).size);
      assert.deepEqual([digest(path.pi), digest(path.codex)], expected);
    } finally { reopened.close(); }
  }
});

test("unverifiable pending write neither advances nor changes a native file", async (t) => {
  const { db, engine, path, warnings } = fixture(t);
  try {
    add(path.pi, "first");
    db.exec(`CREATE TRIGGER fail_commit BEFORE UPDATE OF status ON native_writes BEGIN
      SELECT RAISE(ABORT, 'simulated lost cursor commit'); END`);
    await engine.sync();
    db.exec("DROP TRIGGER fail_commit");
    const length = statSync(path.codex).size;
    truncateSync(path.codex, length - 1);
    await engine.sync();
    assert.match(warnings.at(-1), /Incomplete native write/);
    assert.equal(binding(db, "codex").last_byte_offset, 0);
    appendFileSync(path.codex, "X");
    const before = digest(path.codex);
    await engine.sync();
    assert.match(warnings.at(-1), /does not match ledger/);
    assert.equal(binding(db, "codex").last_byte_offset, 0);
    assert.equal(digest(path.codex), before);
  } finally { db.close(); }
});

test("sixth fanout opens the circuit; ingestion continues and resume flushes or preserves a fork", async (t) => {
  const { db, engine, path, warnings } = fixture(t);
  try {
    for (let i = 0; i < 7; i++) {
      add(path.pi, "round-" + i);
      await engine.sync();
    }
    assert.equal(thread(db).status, "CIRCUIT_OPEN");
    assert.equal(count(db, "native_writes"), 5);
    assert.equal(count(db, "turns"), 7);
    assert.match(warnings.at(-1), /circuit/);
    await engine.resume("th_one");
    assert.equal(thread(db).status, "SYNCED");
    assert.equal(count(db, "native_writes"), 7);

    for (let i = 7; i < 12; i++) {
      add(path.pi, "round-" + i);
      await engine.sync();
    }
    assert.equal(thread(db).status, "CIRCUIT_OPEN");
    add(path.codex, "other branch");
    await engine.sync();
    assert.equal(count(db, "turns"), 13);
    await engine.resume("th_one");
    assert.equal(thread(db).status, "DIVERGED");
    assert.equal(count(db, "native_writes"), 11);
  } finally { db.close(); }
});
