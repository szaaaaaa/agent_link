import type { Stats } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

const BLOCK_SIZE = 64 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;

interface JsonlLine {
  startOffset: number;
  endOffset: number;
  /** null means the complete line was skipped because it exceeded 2 MiB. */
  text: string | null;
}

// Called while holding a writer lease; only the final complete record is needed for native continuity.
export async function readJsonlTail(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const offset = Math.max(0, size - MAX_LINE_BYTES - 2);
    const buffer = Buffer.allocUnsafe(size - offset);
    for (let pos = 0; pos < buffer.length;) {
      const { bytesRead } = await file.read(buffer, pos, buffer.length - pos, offset + pos);
      if (!bytesRead) throw new Error("Native tail was truncated");
      pos += bytesRead;
    }
    if (buffer.at(-1) !== 0x0a) throw new Error("Native file does not end at a complete record");
    const previous = buffer.length > 1 ? buffer.lastIndexOf(0x0a, buffer.length - 2) : -1;
    if (previous === -1 && offset > 0 || buffer.length - previous - 2 > MAX_LINE_BYTES) {
      throw new Error("Native tail exceeds 2 MiB");
    }
    return buffer.toString("utf8", previous + 1, buffer.length - 1);
  } finally { await file.close(); }
}

export function sameSnapshot(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export async function* readJsonlLines(
  source: string | FileHandle, offset = 0, snapshot?: Stats, end = Infinity,
): AsyncGenerator<JsonlLine> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Invalid JSONL offset");

  const file = typeof source === "string" ? await open(source, "r") : source;
  try {
    // Use the approved snapshot, so a writer cannot add bytes after the debounce check.
    const info = await file.stat();
    if (snapshot && !sameSnapshot(snapshot, info)) return;
    const size = Math.min(info.size, end);
    if (offset > size) throw new RangeError("JSONL offset exceeds file size");

    const block = Buffer.allocUnsafe(BLOCK_SIZE);
    let carry: Buffer | undefined;
    let length = 0;
    let oversized = false;
    let startOffset = offset;

    for (let pos = offset; pos < size;) {
      const { bytesRead } = await file.read(block, 0, Math.min(BLOCK_SIZE, size - pos), pos);
      if (bytesRead === 0) throw new Error("JSONL file was truncated during read");
      const chunk = block.subarray(0, bytesRead);

      for (let start = 0; start < bytesRead;) {
        const newline = chunk.indexOf(0x0a, start);
        const fragment = chunk.subarray(start, newline === -1 ? bytesRead : newline);

        if (!oversized) {
          if (length + fragment.length > MAX_LINE_BYTES) {
            oversized = true;
          } else if (newline === -1 || length > 0) {
            carry ??= Buffer.allocUnsafe(MAX_LINE_BYTES);
            fragment.copy(carry, length);
            length += fragment.length;
          }
        }
        if (newline === -1) break;

        let text: string | null = null;
        if (!oversized) {
          const line = length > 0 ? carry!.subarray(0, length) : fragment;
          const end = line.at(-1) === 0x0d ? line.length - 1 : line.length;
          text = line.toString("utf8", 0, end);
        }

        const endOffset = pos + newline + 1;
        yield { startOffset, endOffset, text };
        start = newline + 1;
        startOffset = endOffset;
        oversized = false;
        length = 0;
      }

      pos += bytesRead;
    }
  } finally {
    if (typeof source === "string") await file.close();
  }
}
