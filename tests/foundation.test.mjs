import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openStateDb } from "../dist/core/db.js";
import { normalizeWorkspace, resolveWorkspace } from "../dist/core/workspace.js";

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("workspace aliases match exactly; candidates are tried in order", (t) => {
  const dir = sandbox(t);
  const watched = join(dir, "Watched #1");
  const other = join(dir, "Other");
  const child = join(watched, "child");
  mkdirSync(child, { recursive: true });
  mkdirSync(other);
  const alias = join(dir, "alias");
  symlinkSync(watched, alias, process.platform === "win32" ? "junction" : "dir");

  const key = normalizeWorkspace(watched);
  const otherKey = normalizeWorkspace(other);
  assert.ok(key);
  assert.ok(otherKey);
  const enabled = new Set([key, otherKey]);

  assert.equal(normalizeWorkspace(parse(watched).root), process.platform === "win32"
    ? parse(watched).root.replaceAll("\\", "/").toLowerCase()
    : "/");
  assert.equal(resolveWorkspace([watched + sep], enabled), key);
  assert.equal(resolveWorkspace([pathToFileURL(watched).href.replace(/^file:\/\/\/([A-Za-z]):\//, "file:///$1%3A/")], enabled), key);
  assert.equal(resolveWorkspace(["file:///%bad", ".", child, alias, other], enabled), key);
  assert.equal(resolveWorkspace([other, alias], enabled), otherKey);
  assert.equal(resolveWorkspace([child, other], new Set([key])), null);

  if (process.platform === "win32") {
    assert.equal(normalizeWorkspace(watched.toUpperCase()), key);
    assert.equal(normalizeWorkspace("\\\\?\\" + watched), key);
  } else {
    mkdirSync(join(dir, "Watched #1\\child"));
    assert.notEqual(normalizeWorkspace(join(dir, "Watched #1\\child")), normalizeWorkspace(child));
  }
});

test("SQLite initializes state tables and preserves state on reopen", (t) => {
  const dir = sandbox(t);
  let db = openStateDb(dir);
  try {
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
    assert.deepEqual(tables.map((row) => row.name), ["agy_sessions", "bindings", "codex_deliveries", "native_writes", "pi_entries", "threads", "turns", "workspaces"]);
    db.prepare("INSERT INTO workspaces (workspace_key, raw_path, created_at) VALUES (?, ?, ?)").run(dir, dir, 1);
    const insert = db.prepare(
      "INSERT INTO bindings (thread_id, agent, native_session_id, updated_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("th_1", "pi", "pi_1", 1);
    assert.throws(() => insert.run("th_2", "pi", "pi_1", 1), /UNIQUE constraint failed/);
    assert.throws(() => insert.run("th_1", "pi", "pi_2", 1), /UNIQUE constraint failed/);
  } finally {
    db.close();
  }
  db = openStateDb(dir);
  try {
    assert.equal(db.prepare("SELECT enabled FROM workspaces WHERE workspace_key = ?").get(dir).enabled, 1);
    assert.equal(db.prepare("SELECT last_byte_offset FROM bindings").get().last_byte_offset, 0);
  } finally {
    db.close();
  }
});

test("CLI reports its version and rejects runtimes below the declared minimum", () => {
  const entry = new URL("../dist/cli.js", import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(entry), "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const unsupported = spawnSync(process.execPath, ["--input-type=module", "-e", [
    'Object.defineProperty(process.versions, "node", { value: "22.12.0" });',
    "await import(" + JSON.stringify(entry.href) + ");",
  ].join("\n")], { encoding: "utf8" });
  assert.equal(unsupported.status, 1, unsupported.stderr);
  assert.match(unsupported.stderr, /requires Node\.js >= 22\.13\.0 \(found 22\.12\.0\)/);
});
