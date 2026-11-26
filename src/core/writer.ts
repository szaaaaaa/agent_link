import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Binding } from "./engine.js";

const BACKUP_LIMIT = 100_000_000;
const TAIL_SIZE = 64 * 1024;

export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

interface WriteRecord {
  start_offset: number;
  end_offset: number;
  turn_id: string;
  payload_hash: string | null;
  requires_projection: number;
  resume_turn_id: string | null;
}

async function readExact(file: FileHandle, buffer: Buffer, offset: number): Promise<void> {
  for (let pos = 0; pos < buffer.length;) {
    const { bytesRead } = await file.read(buffer, pos, buffer.length - pos, offset + pos);
    if (bytesRead === 0) throw new Error("Unexpected EOF while verifying native file");
    pos += bytesRead;
  }
}

function finish(db: DatabaseSync, binding: Binding, write: WriteRecord): void {
  transaction(db, () => {
    db.prepare("UPDATE native_writes SET status = 'done' WHERE native_path = ? AND start_offset = ?")
      .run(binding.native_path, write.start_offset);
    db.prepare(`UPDATE bindings SET last_byte_offset = ?, last_written_turn_id = ?,
      last_seen_turn_id = CASE WHEN ? = 0 THEN COALESCE(?, last_seen_turn_id) ELSE last_seen_turn_id END,
      updated_at = ? WHERE thread_id = ? AND agent = ?`).run(write.end_offset, write.turn_id,
        write.requires_projection, write.resume_turn_id, Date.now(), binding.thread_id, binding.agent);
  });
  binding.last_byte_offset = write.end_offset;
  binding.last_written_turn_id = write.turn_id;
  if (!write.requires_projection && write.resume_turn_id) binding.last_seen_turn_id = write.resume_turn_id;
}

export async function verifyWrite(file: FileHandle, path: string, write: WriteRecord): Promise<void> {
  const { start_offset: start, end_offset: end, payload_hash: digest } = write;
  if (!digest || end <= start) throw new Error(`Cannot verify native write: ${path}:${start}`);
  if ((await file.stat()).size < end) throw new Error(`Incomplete native write: ${path}:${start}`);
  const hash = createHash("sha256");
  const block = Buffer.allocUnsafe(Math.min(TAIL_SIZE, end - start));
  for (let pos = start; pos < end;) {
    const part = block.subarray(0, Math.min(block.length, end - pos));
    await readExact(file, part, pos);
    hash.update(part);
    pos += part.length;
  }
  if (hash.digest("hex") !== digest) throw new Error(`Native write does not match ledger: ${path}:${start}`);
}

export async function recoverNativeWrite(db: DatabaseSync, binding: Binding): Promise<void> {
  const write = db.prepare("SELECT * FROM native_writes WHERE native_path = ? AND status = 'pending'")
    .get(binding.native_path) as unknown as WriteRecord | undefined;
  if (!write) return;

  const file = await open(binding.native_path, "r");
  try {
    const { size } = await file.stat();
    if (!write.payload_hash || write.start_offset !== binding.last_byte_offset ||
        write.end_offset <= write.start_offset) {
      throw new Error(`Cannot verify native write: ${binding.native_path}:${write.start_offset}`);
    }
    if (size === write.start_offset) {
      db.prepare("DELETE FROM native_writes WHERE native_path = ? AND start_offset = ?")
        .run(binding.native_path, write.start_offset);
      return;
    }
    await verifyWrite(file, binding.native_path, write);
    finish(db, binding, write);
  } finally {
    await file.close();
  }
}

async function backup(dataDir: string, file: FileHandle, path: string, offset: number): Promise<void> {
  const dir = join(dataDir, "backups");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tail = Buffer.allocUnsafe(Math.min(offset, TAIL_SIZE));
  await readExact(file, tail, offset - tail.length);
  const header = Buffer.from(JSON.stringify({ path, offset, tailOffset: offset - tail.length }) + "\n");
  const entries = (await readdir(dir)).filter((name) => /^\d+-[a-f0-9-]+\.bak$/.test(name)).sort();
  let total = header.length + tail.length;
  const sizes: number[] = [];
  for (const name of entries) {
    const size = (await stat(join(dir, name))).size;
    sizes.push(size);
    total += size;
  }
  for (let i = 0; total > BACKUP_LIMIT && i < entries.length; i++) {
    await unlink(join(dir, entries[i]));
    total -= sizes[i];
  }
  const snapshot = await open(join(dir, `${Date.now()}-${randomUUID()}.bak`), "wx", 0o600);
  try {
    await snapshot.writeFile(Buffer.concat([header, tail]));
    await snapshot.sync();
  } finally {
    await snapshot.close();
  }
}

export type AppendPayload = (offset: number, bytes: Buffer) => Promise<void>;

// The caller must hold exclusive permission for the whole drain/append operation.
export async function appendNative(
  db: DatabaseSync, dataDir: string, binding: Binding, turnId: string, text: string, leasedAppend?: AppendPayload,
  requiresProjection = false, resumeTurnId = turnId,
): Promise<boolean> {
  if (!text.endsWith("\n") || text.split("\n").slice(0, -1).some((line) => !line.trim())) {
    throw new Error("Native append must contain complete JSONL records");
  }
  const payload = Buffer.from(text);
  const file = await open(binding.native_path, "r");
  try {
    const { size } = await file.stat();
    if (size !== binding.last_byte_offset) return false;
    await backup(dataDir, file, binding.native_path, size);
    if ((await file.stat()).size !== size) return false;
    const write = {
      start_offset: size, end_offset: size + payload.length, turn_id: turnId,
      payload_hash: createHash("sha256").update(payload).digest("hex"), requires_projection: Number(requiresProjection),
      resume_turn_id: resumeTurnId,
    };
    transaction(db, () => {
      db.prepare(`INSERT INTO native_writes (agent, native_path, start_offset, end_offset, turn_id, status, created_at,
        payload_hash, requires_projection, resume_turn_id) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
        .run(binding.agent, binding.native_path, size, write.end_offset, turnId, Date.now(), write.payload_hash,
          write.requires_projection, resumeTurnId);
      if (requiresProjection) db.prepare(`UPDATE bindings SET projection_pending = 1 WHERE thread_id = ? AND agent = ?`)
        .run(binding.thread_id, binding.agent);
    });
    if (leasedAppend) await leasedAppend(size, payload);
    else {
      const append = await open(binding.native_path, constants.O_WRONLY | constants.O_APPEND);
      try {
        const info = await append.stat();
        const original = await file.stat();
        if (info.size !== size || original.ino !== info.ino || original.dev !== info.dev) {
          throw new Error(`Native file changed before append: ${binding.native_path}:${size}`);
        }
        await append.writeFile(payload);
        await append.sync();
      } finally { await append.close(); }
    }
    if ((await file.stat()).size !== write.end_offset) {
      throw new Error(`Native file changed during append: ${binding.native_path}:${size}`);
    }
    await verifyWrite(file, binding.native_path, write);
    finish(db, binding, write);
    return true;
  } finally {
    await file.close();
  }
}
