export type Agent = "pi" | "codex" | "antigravity";

export type ToolEvent =
  | { kind: "edit"; path: string; added: number; removed: number }
  | { kind: "command"; command: string; exitCode?: number; errorOutput?: string }
  | { kind: "oversized" };

// Adapters extract final visible text and tool summaries; errorOutput must exclude file bodies and directory listings.
export interface NativeTurn {
  userText: string;
  assistantText: string;
  tools: readonly ToolEvent[];
}

export interface TurnContent {
  user_text: string;
  assistant_text: string;
  tool_digest: string[];
  touched_files: string[];
}

export interface Turn extends TurnContent {
  turn_id: string;
  parent_turn_id: string | null;
  merge_parent_turn_id?: string;
  origin_agent: Agent | "agent-link";
  git_head: string | null;
  git_fp: string | null;
  created_at: number;
}
