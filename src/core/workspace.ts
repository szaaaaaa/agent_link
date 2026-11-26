import { realpathSync } from "node:fs";
import { isAbsolute, normalize, parse } from "node:path";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";

function stripWindowsPrefix(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
}

export function normalizeWorkspace(path: string): string | null {
  if (/^file:/i.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      return null;
    }
  }

  const absolute = windows
    ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/.])/i.test(stripWindowsPrefix(path))
    : isAbsolute(path);
  if (!absolute || path.includes("\0")) return null;

  try {
    path = realpathSync.native(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return null;
  }

  const normalized = normalize(windows ? stripWindowsPrefix(path) : path);
  const root = parse(normalized).root;
  const trimmed = normalized.length === root.length
    ? normalized
    : normalized.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  return windows ? trimmed.replaceAll("\\", "/").toLowerCase() : trimmed;
}

export function resolveWorkspace(
  candidates: readonly string[],
  enabledWorkspaceKeys: ReadonlySet<string>,
): string | null {
  for (const candidate of candidates) {
    const key = normalizeWorkspace(candidate);
    if (key !== null && enabledWorkspaceKeys.has(key)) return key;
  }
  return null;
}
