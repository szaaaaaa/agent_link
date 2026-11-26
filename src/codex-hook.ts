import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { resolveWorkspace } from "./core/workspace.js";
import { DaemonUnavailable, ensureDaemon, request } from "./daemon/lifecycle.js";

export async function runCodexPromptHook(dir: string, cli: string): Promise<unknown> {
  const deadline = Date.now() + 2500;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      if ((bytes += chunk.length) > 1024 * 1024) return {};
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (input?.hook_event_name !== "UserPromptSubmit" || typeof input.cwd !== "string" ||
        typeof input.session_id !== "string" || !input.session_id || input.session_id.length > 256 ||
        typeof input.turn_id !== "string" || !input.turn_id || input.turn_id.length > 256 ||
        typeof input.transcript_path !== "string" || !isAbsolute(input.transcript_path)) return {};
    const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    const enabled = new Set<string>(config.workspaces.map((row: { workspace_key: string }) => row.workspace_key));
    if (!resolveWorkspace([input.cwd], enabled)) return {};
    // Forward identifiers only, not the user's prompt or other Codex environment metadata.
    const arg = JSON.stringify({ session: input.session_id, turn: input.turn_id, path: input.transcript_path,
      cwd: input.cwd, deadline: deadline - 100 });
    if (Buffer.byteLength(arg) > 12_000 || Date.now() >= deadline) return {};
    let context: unknown;
    try { context = await request(dir, "codex-pull", arg, remaining()); }
    catch (error) {
      if (!(error instanceof DaemonUnavailable)) throw error;
      await ensureDaemon(dir, cli, remaining());
      if (Date.now() < deadline) context = await request(dir, "codex-pull", arg, remaining());
    }
    return typeof context === "string" && context ? {
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
    } : {};
  } catch { return {}; }
}
