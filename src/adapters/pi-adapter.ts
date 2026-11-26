import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { NativeTurn, Turn } from "./types.js";

type Entry = {
  id?: string;
  parentId?: string | null;
  type: string;
  customType?: string;
  details?: { turnId?: string };
  message?: { role: string; content: string | { type: string; text?: string }[]; stopReason?: string };
};

export function piHeader(line: string): { id: string; cwd: string } | null {
  const row = JSON.parse(line);
  return row?.type === "session" && typeof row.id === "string" && row.id && typeof row.cwd === "string"
    ? { id: row.id, cwd: row.cwd } : null;
}

function text(content: NonNullable<Entry["message"]>["content"]): string {
  return typeof content === "string" ? content : content.filter((item) => item.type === "text")
    .map((item) => item.text ?? "").join("\n");
}

export function piParent(parentId: string | null, lookup: (id: string) => {
  parentId: string | null; turnId?: string;
} | undefined, resumeAt?: (turnId: string) => string | null | undefined): string | null {
  const visited = new Set<string>();
  for (let id = parentId; id !== null;) {
    if (visited.has(id)) throw new Error("Cycle in Pi parent chain: " + id);
    visited.add(id);
    const projected = /^al_(tu_[0-9A-Z]+)_[ua]$/.exec(id);
    if (projected) return resumeAt?.(projected[1]) ?? projected[1];
    const node = lookup(id);
    if (!node) throw new Error("Missing Pi parent entry: " + id);
    if (node.turnId) return node.turnId;
    id = node.parentId;
  }
  return null;
}

export function piReader(parentOf: (id: string | null) => string | null, remember: (entry: Entry) => void) {
  let user: { id: string; text: string; parentId: string | null; oversized: boolean } | undefined;
  return (line: string | null): (NativeTurn & { anchor: string; parentTurnId: string | null }) | null | undefined => {
    if (line === null) {
      if (user) user.oversized = true;
      return user ? undefined : null;
    }
    const entry: Entry = JSON.parse(line);
    if (entry.id) remember(entry);
    if (entry.id?.startsWith("al_") || entry.customType === "agent-link" || entry.type !== "message" || !entry.message) {
      return user ? undefined : null;
    }
    const msg = entry.message;
    if (entry.id && msg.role === "user") {
      user = { id: entry.id, text: text(msg.content), parentId: entry.parentId ?? null, oversized: false };
    } else if (user && entry.id && msg.role === "assistant" && (msg.stopReason === "stop" || msg.stopReason === "length")) {
      const source = user;
      user = undefined;
      // Pi writes before_agent_start messages after the user; follow the final answer's chain to include them.
      const parentTurnId = parentOf(entry.parentId ?? source.parentId);
      return { anchor: entry.id, userText: source.text, assistantText: text(msg.content), parentTurnId,
        tools: source.oversized ? [{ kind: "oversized" }] : [] };
    } else if (msg.role === "assistant" && (msg.stopReason === "aborted" || msg.stopReason === "error")) {
      user = undefined;
    }
    return user ? undefined : null;
  };
}

export function piSessionDir(root: string, cwd: string): string {
  return join(root, "--" + resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--");
}

export function describePiSession(dir: string, cwd: string) {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  return { id, path: join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`),
    header: JSON.stringify({ type: "session", version: 3, id, timestamp, cwd }) + "\n" };
}

export async function createPiSession(root: string, cwd: string, existingDir = piSessionDir(root, cwd)) {
  const { id, path, header } = describePiSession(existingDir, cwd);
  await mkdir(existingDir, { recursive: true });
  await writeFile(path, header, { flag: "wx", mode: 0o600 });
  return { id, path };
}

export function encodePiTurn(turn: Turn, parentId: string | null): string {
  const timestamp = new Date(turn.created_at).toISOString();
  const user = `al_${turn.turn_id}_u`;
  const assistant = `al_${turn.turn_id}_a`;
  const entry = (id: string, parent: string | null, message: object) =>
    JSON.stringify({ type: "message", id, parentId: parent, timestamp, message }) + "\n";
  const content = (text: string) => [{ type: "text", text }];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return entry(user, parentId, { role: "user", content: content(turn.user_text), timestamp: turn.created_at }) +
    entry(assistant, user, { role: "assistant", content: content(turn.assistant_text +
      (turn.tool_digest.length ? "\n\n```text\n" + turn.tool_digest.join("\n") + "\n```" : "")),
      api: "openai-completions", provider: "agent-link", model: "synced", usage, stopReason: "stop", timestamp: turn.created_at });
}
