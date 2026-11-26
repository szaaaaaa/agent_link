import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { agyTranscriptSnapshot, defaultAgyReply, isNormalAgyStop, parseAgyHook } from "./adapters/agy-adapter.js";
import type { AgyEvent } from "./adapters/agy-adapter.js";
import { resolveWorkspace } from "./core/workspace.js";
import { DaemonUnavailable, ensureDaemon, request } from "./daemon/lifecycle.js";

export interface AgyStopJob {
  workspace: string;
  conversationId: string;
  path: string;
  snapshot: { bytes: number; key: string };
}

export const agyInbox = (dir: string) => join(dir, "hook-inbox");

async function spoolStop(dir: string, job: AgyStopJob): Promise<void> {
  const inbox = agyInbox(dir);
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  const target = join(inbox, `${Date.now()}-${randomUUID()}.json`);
  const tmp = target + ".tmp";
  try {
    const file = await open(tmp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(job) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(tmp, target);
  } finally { await rm(tmp, { force: true }); }
}

export async function runAgyHook(event: AgyEvent, dir: string, cli: string): Promise<unknown> {
  const fallback = defaultAgyReply(event);
  const deadline = Date.now() + 3000;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      if ((bytes += chunk.length) > 1024 * 1024) return fallback;
      chunks.push(chunk);
    }
    const hook = parseAgyHook(event, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!hook || event === "Stop" && !isNormalAgyStop(hook)) return fallback;
    const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    const enabled = new Set<string>(config.workspaces.map((row: { workspace_key: string }) => row.workspace_key));
    const workspace = resolveWorkspace(hook.candidates, enabled);
    if (!workspace) return fallback;

    const input = { conversationId: hook.conversationId, workspacePaths: hook.candidates,
      transcriptPath: hook.transcriptPath, lastUserInput: hook.lastUserInput, invocationNum: hook.invocationNum,
      initialNumSteps: hook.initialNumSteps, hookEventName: event };
    if (event === "Stop" && hook.transcriptPath) {
      await spoolStop(dir, { conversationId: hook.conversationId, workspace, path: hook.transcriptPath,
        snapshot: await agyTranscriptSnapshot(hook.transcriptPath) });
    }
    const command = event === "Stop" ? "daemon-status" : "agy-" + event;
    // Leave a small margin so the daemon won't commit an injection after the hook has timed out.
    const arg = event === "Stop" ? undefined : JSON.stringify({ input, deadline: deadline - 100 });
    if (arg && Buffer.byteLength(arg) > 12_000 || Date.now() >= deadline) return fallback;
    let result: unknown;
    try { result = await request(dir, command, arg, remaining()); }
    catch (error) {
      if (!(error instanceof DaemonUnavailable)) throw error;
      await ensureDaemon(dir, cli, remaining());
      if (event !== "Stop" && Date.now() < deadline) result = await request(dir, command, arg, remaining());
    }
    return event === "Stop" ? fallback : result ?? fallback;
  } catch {
    // Hooks fail open; a complete Stop job is already durable if daemon startup failed.
    return fallback;
  }
}
