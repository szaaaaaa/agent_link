import assert from "node:assert/strict";
import { appendFileSync, closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { resourceUsage } from "node:process";
import test from "node:test";
import { readJsonlLines } from "../dist/core/jsonl.js";

const KiB = 1024;
const MiB = 1024 * KiB;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-link-jsonl-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "session.jsonl");
}

async function lines(path, offset, snapshot) {
  const result = [];
  for await (const line of readJsonlLines(path, offset, snapshot)) result.push(line);
  return result;
}

test("100 MiB oversized line is skipped without losing the next record or retaining its bytes", async (t) => {
  const file = fixture(t);
  const payload = Buffer.alloc(MiB, 0x61);
  const fd = openSync(file, "w");
  try {
    for (let i = 0; i < 100; i++) writeSync(fd, payload);
    writeSync(fd, '\n{"new":true}\n');
  } finally {
    closeSync(fd);
  }

  const before = resourceUsage().maxRSS;
  const start = performance.now();
  const actual = await lines(file);
  const deltaKiB = resourceUsage().maxRSS - before;
  t.diagnostic("Peak RSS increase: " + (deltaKiB / KiB).toFixed(2) + " MiB; full scan: " +
    (performance.now() - start).toFixed(0) + " ms");
  assert.ok(deltaKiB < 30_000, "scan increased peak RSS by 30 MB or more");
  assert.deepEqual(actual, [
    { startOffset: 0, endOffset: 100 * MiB + 1, text: null },
    { startOffset: 100 * MiB + 1, endOffset: 100 * MiB + 14, text: '{"new":true}' },
  ]);
});

test("JSONL cursors count bytes across split UTF-8 and resume a partial line", async (t) => {
  const file = fixture(t);
  const prefix = '{"s":"';
  const row = prefix + "a".repeat(64 * KiB - 1 - prefix.length) + '雪"}';
  const firstEnd = Buffer.byteLength(row + "\r\n");
  writeFileSync(file, row + '\r\n{"x":');
  assert.deepEqual(await lines(file), [{ startOffset: 0, endOffset: firstEnd, text: row }]);

  appendFileSync(file, "1}\n");
  assert.deepEqual(await lines(file, firstEnd), [
    { startOffset: firstEnd, endOffset: firstEnd + 8, text: '{"x":1}' },
  ]);
  await assert.rejects(lines(file, -1), /Invalid JSONL offset/);
  await assert.rejects(lines(file, firstEnd + 9), /offset exceeds file size/);
});

test("2 MiB is accepted, oversize is only reported after a newline", async (t) => {
  const file = fixture(t);
  const row = "a".repeat(2 * MiB);
  writeFileSync(file, row + "\n" + row + "a");
  const firstEnd = 2 * MiB + 1;
  assert.deepEqual(await lines(file), [{ startOffset: 0, endOffset: firstEnd, text: row }]);
  assert.deepEqual(await lines(file, firstEnd), []);

  appendFileSync(file, "\n");
  assert.deepEqual(await lines(file, firstEnd), [
    { startOffset: firstEnd, endOffset: firstEnd + 2 * MiB + 2, text: null },
  ]);
});

test("an append during a read is left for the next pass", async (t) => {
  const file = fixture(t);
  writeFileSync(file, "{}\n");
  const snapshot = statSync(file);
  const current = readJsonlLines(file, 0, snapshot);
  assert.equal((await current.next()).value.endOffset, 3);
  appendFileSync(file, "[]\n");
  assert.equal((await current.next()).done, true);
  assert.deepEqual(await lines(file, 0, snapshot), []);
  assert.deepEqual(await lines(file, 3), [{ startOffset: 3, endOffset: 6, text: "[]" }]);
});
