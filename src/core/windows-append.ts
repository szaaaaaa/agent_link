import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AppendPayload } from "./writer.js";

// FileShare.Read denies competing opens for write or deletion while the ledger is prepared and committed.
const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $file = [IO.File]::Open($env:AGENT_LINK_LEASE_PATH, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
  try {
    [Console]::WriteLine('ready')
    while ($null -ne ($line = [Console]::ReadLine())) {
      $fields = $line.Split(' ', 2)
      if ($file.Length -ne [long]$fields[0]) { throw 'Native end offset changed' }
      $payload = [Convert]::FromBase64String($fields[1])
      $file.Position = $file.Length
      $file.Write($payload, 0, $payload.Length)
      $file.Flush($true)
      [Console]::WriteLine('ok')
    }
  } finally { $file.Dispose() }
} catch { [Console]::WriteLine('failed'); exit 1 }
`;

export async function withWindowsAppend<T>(path: string, run: (append: AppendPayload) => Promise<T>): Promise<T> {
  if (process.platform !== "win32") throw new Error("Verified offline file leases are currently supported only on Windows");
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, AGENT_LINK_LEASE_PATH: path }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  child.on("error", () => lines.close());
  child.stdin.on("error", () => lines.close());
  async function expect(expected: string, error: string) {
    const timeout = setTimeout(() => { lines.close(); child.kill(); }, 8000);
    try {
      if ((await replies.next()).value !== expected) throw new Error(`${error}: ${path}`);
    } finally { clearTimeout(timeout); }
  }
  try {
    await expect("ready", "Cannot acquire exclusive writer lease; close the target client and retry");
    return await run(async (offset, bytes) => {
      child.stdin.write(`${offset} ${bytes.toString("base64")}\n`);
      await expect("ok", "Native append interrupted; ledger retained for recovery");
    });
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 1500);
    try { await closed; } finally { clearTimeout(timer); lines.close(); }
  }
}
