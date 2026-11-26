import { lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { readJsonlLines } from "../core/jsonl.js";
import type { NativeTurn, ToolEvent } from "./types.js";

export type AgyEvent = "SessionStart" | "PreInvocation" | "Stop";

export interface AgyHook {
  event: AgyEvent;
  conversationId: string;
  candidates: string[];
  transcriptPath?: string;
  lastUserInput?: string;
  invocationNum?: number;
  initialNumSteps?: number;
  terminationReason?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function index(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function transcriptPath(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && isAbsolute(value) && basename(value) === "transcript.jsonl";
}

export function parseAgyHook(event: AgyEvent, input: unknown): AgyHook | null {
  const row = object(input);
  if (!row || (row.hookEventName !== undefined && row.hookEventName !== event) ||
      typeof row.conversationId !== "string" || !row.conversationId || row.conversationId.length > 256 ||
      row.conversationId.includes("\0")) return null;
  const paths = Array.isArray(row.workspacePaths) ? row.workspacePaths.filter((value) => typeof value === "string") : [];
  if (typeof row.cwd === "string") paths.push(row.cwd);
  const supplied = row.transcriptPath;
  // The CLI reports the full companion, but our byte cursor belongs to the primary transcript.
  const path = transcriptPath(supplied) ? supplied
    : typeof supplied === "string" && !supplied.includes("\0") && isAbsolute(supplied) && basename(supplied) === "transcript_full.jsonl"
      ? join(dirname(supplied), "transcript.jsonl") : undefined;
  if (event === "Stop" && (!path || typeof row.terminationReason !== "string")) return null;
  return { event, conversationId: row.conversationId, candidates: paths, transcriptPath: path,
    lastUserInput: typeof row.lastUserInput === "string" ? row.lastUserInput : undefined,
    invocationNum: index(row.invocationNum) ? row.invocationNum : undefined,
    initialNumSteps: index(row.initialNumSteps) ? row.initialNumSteps : undefined,
    terminationReason: typeof row.terminationReason === "string" ? row.terminationReason : undefined };
}

export function isNormalAgyStop(hook: AgyHook): boolean {
  return hook.event === "Stop" && (hook.terminationReason === "NO_TOOL_CALL" || hook.terminationReason === "model_stop");
}

export function defaultAgyReply(event: AgyEvent) {
  return event === "Stop" ? { decision: "stop" as const } : {};
}

export function agyInjection(content: string, userMarkdown?: string) {
  return { injectSteps: [{ systemMessage: { systemMessage: content,
    ...(userMarkdown ? { metadata: { user_markdown: userMarkdown } } : {}) } }] };
}

export interface AgyCursor { byteOffset: number; fullByteOffset: number }
interface AgyTurn extends NativeTurn {
  anchor: string;
  lastStep: number;
  cursor: AgyCursor;
}

function parseStep(text: string, at: number) {
  let row;
  try { row = object(JSON.parse(text)); } catch { /* Do not echo transcript strings in errors. */ }
  if (!row || !index(row.step_index) || typeof row.type !== "string") {
    throw new Error(`Invalid Antigravity transcript step at byte ${at}`);
  }
  return { ...row, step_index: row.step_index, type: row.type } as Record<string, unknown> &
    { step_index: number; type: string };
}

export async function agyTranscriptSnapshot(path: string) {
  if (!transcriptPath(path)) throw new Error("Expected an absolute transcript.jsonl path");
  const info = await snapshot(path);
  return { bytes: info.size, key: `${info.dev}:${info.ino}` };
}

async function snapshot(path: string) {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error("Antigravity transcript must be a regular JSONL file");
  return info;
}

function userText(content: string): string | undefined {
  if (content.trimStart().startsWith("<USER_REQUEST>")) {
    const start = content.indexOf("<USER_REQUEST>") + "<USER_REQUEST>".length;
    const end = content.indexOf("</USER_REQUEST>", start);
    return end === -1 ? undefined : content.slice(start, end).trim();
  }
  return content.split(/<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/, 1)[0].trim();
}

function summarize(calls: unknown, tools: ToolEvent[]) {
  if (!Array.isArray(calls)) return;
  for (const call of calls) {
    const item = object(call);
    const args = object(item?.args);
    if (!args) continue;
    if (item?.name === "run_command" && typeof args.CommandLine === "string") {
      // shortcut: the tool-call step has no exit status; add it when a verified structured result is available.
      tools.push({ kind: "command", command: args.CommandLine });
    } else if (item?.name === "edit_file" && typeof args.Path === "string" &&
        typeof args.Target === "string" && typeof args.Replacement === "string") {
      const lines = (value: string) => value ? value.trimEnd().split(/\r?\n/).length : 0;
      tools.push({ kind: "edit", path: args.Path, added: lines(args.Replacement), removed: lines(args.Target) });
    }
  }
}

export async function agyUserBoundary(path: string, input: string, offset: number, key: string) {
  if (!transcriptPath(path)) throw new Error("Expected an absolute transcript.jsonl path");
  const info = await snapshot(path);
  if (`${info.dev}:${info.ino}` !== key) return null;
  let latest: { step: number; offset: number; body?: string } | undefined;
  let end = offset;
  for await (const line of readJsonlLines(path, offset, info)) {
    if (line.text === null) return null;
    const step = parseStep(line.text, line.startOffset);
    end = line.endOffset;
    if (step.type === "USER_INPUT") latest = { step: step.step_index, offset: line.startOffset,
      body: step.status === "DONE" && typeof step.content === "string" ? userText(step.content) : undefined };
  }
  const text = (value: string) => value.replaceAll("\r\n", "\n").trim();
  return end === info.size && latest?.body !== undefined && text(latest.body) === text(input)
    ? { ...latest, size: info.size } : null;
}

// Call after a normal Stop. Only yielded turns have cursor positions safe to commit together.
export async function* readAgyTranscript(
  path: string, cursor: AgyCursor = { byteOffset: 0, fullByteOffset: 0 }, stop?: { bytes: number; key: string },
): AsyncGenerator<AgyTurn> {
  if (!transcriptPath(path)) throw new Error("Expected an absolute transcript.jsonl path");
  if (!index(cursor.byteOffset) || !index(cursor.fullByteOffset)) throw new RangeError("Invalid Antigravity cursor");
  const info = await snapshot(path);
  if (stop && (!index(stop.bytes) || info.size < stop.bytes || `${info.dev}:${info.ino}` !== stop.key)) {
    throw new Error("Antigravity transcript no longer matches the Stop snapshot");
  }
  const end = stop?.bytes ?? info.size;
  if (cursor.byteOffset > info.size) throw new RangeError("Antigravity cursor exceeds transcript size");
  if (cursor.byteOffset >= end) return;
  const fullPath = join(dirname(path), "transcript_full.jsonl");
  let full: ReturnType<typeof readJsonlLines> | undefined;
  let fullOffset = cursor.fullByteOffset;
  let fullIndex = -1;
  const lookup = async (target: number) => {
    if (!full) {
      const info = await snapshot(fullPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info) return undefined;
      full = readJsonlLines(fullPath, fullOffset, info);
    }
    for (;;) {
      const entry = await full.next();
      if (entry.done) return undefined;
      const line = entry.value;
      if (line.text === null) continue;
      const step = parseStep(line.text, line.startOffset);
      if (step.step_index <= fullIndex) throw new Error("Antigravity full transcript steps are out of order");
      fullIndex = step.step_index;
      if (step.step_index > target) return undefined;
      fullOffset = line.endOffset;
      if (step.step_index === target) return step;
    }
  };

  let current: { start: number; user: string; answer?: string; tools: ToolEvent[] } | undefined;
  let byteOffset = cursor.byteOffset;
  let lastStep = -1;
  const finish = (): AgyTurn | undefined => current?.answer ? {
    anchor: String(current.start), userText: current.user, assistantText: current.answer,
    tools: current.tools, lastStep, cursor: { byteOffset, fullByteOffset: fullOffset },
  } : undefined;

  try {
    for await (const line of readJsonlLines(path, cursor.byteOffset, info, end)) {
      // An oversize primary record could itself be the next user boundary. Do not join across it.
      if (line.text === null) throw new Error(`Antigravity transcript step exceeds 2 MiB at byte ${line.startOffset}`);
      const step = parseStep(line.text, line.startOffset);
      if (step.step_index <= lastStep) throw new Error("Antigravity transcript steps are out of order");
      const user = step.type === "USER_INPUT";
      if (user) {
        const prior = finish();
        if (prior) yield prior;
        current = undefined;
      }
      if ((user || step.type === "PLANNER_RESPONSE" && current) && step.status === "DONE") {
        const fields = Array.isArray(step.truncated_fields) ? step.truncated_fields : [];
        const needed = fields.filter((field) => field === "content" || !user && field === "tool_calls");
        if (needed.length) {
          const complete = await lookup(step.step_index);
          if (!complete || complete.type !== step.type || complete.status !== "DONE" ||
              needed.some((field) => field === "content" ? typeof complete.content !== "string" : !Array.isArray(complete.tool_calls))) return;
          for (const field of needed) step[field] = complete[field];
        }
        if (user && typeof step.content === "string") {
          const body = userText(step.content);
          if (body === undefined) return;
          current = { start: step.step_index, user: body, tools: [] };
        } else if (!user && current) {
          if (typeof step.content === "string" && step.content.trim()) current.answer = step.content;
          summarize(step.tool_calls, current.tools);
        }
      }
      byteOffset = line.endOffset;
      lastStep = step.step_index;
    }
    const last = byteOffset === end ? finish() : undefined;
    if (last) yield last;
  } finally {
    await full?.return(undefined);
  }
}
