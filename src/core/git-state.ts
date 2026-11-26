import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const MAX_FILES = 20;

export interface GitState {
  head: string | null;
  fingerprint: string;
}

interface WorkspaceGitState extends GitState {
  workingFiles: string[];
}

async function git(cwd: string, args: string[], consume?: (chunk: Buffer) => void) {
  const child = spawn("git", ["--no-optional-locks", ...args], {
    cwd,
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
  });
  if (consume) child.stdout.on("data", consume);
  else child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  return { code: await closed, stdout, stderr };
}

function check(result: Awaited<ReturnType<typeof git>>): string {
  if (result.code !== 0) throw new Error("git failed (" + result.code + "): " + result.stderr.trim());
  return result.stdout;
}

function nulRecords(consume: (record: Buffer) => void): (chunk: Buffer) => void {
  let carry: Buffer = Buffer.alloc(0);
  return (chunk) => {
    if (carry.length) chunk = Buffer.concat([carry, chunk]);
    let start = 0;
    for (let i = chunk.indexOf(0); i !== -1; i = chunk.indexOf(0, start)) {
      consume(chunk.subarray(start, i));
      start = i + 1;
    }
    carry = chunk.subarray(start);
  };
}

async function emptyTree(workspace: string): Promise<string> {
  return check(await git(workspace, ["hash-object", "-t", "tree", "--stdin"])).trim();
}

export async function readGitState(workspace: string): Promise<WorkspaceGitState | null> {
  const repo = await git(workspace, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
  if (repo.code === 128 && repo.stderr.includes("not a git repository")) return null;
  const output = check(repo);
  if (!/^true\r?\n/.test(output)) return null;
  const prefix = output.slice(output.indexOf("\n") + 1).replace(/\r?\n$/, "");

  const ref = await git(workspace, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const head = ref.code === 1 ? null : check(ref).trim();
  const hash = createHash("sha256");
  // Hash stdout as it arrives; a large diff must not consume daemon memory.
  check(await git(workspace, ["diff", "--relative", "--no-ext-diff", "--no-textconv", "--no-color",
    "--no-renames", head ?? await emptyTree(workspace), "--", "."], (chunk) => hash.update(chunk)));
  hash.update("\0");

  const workingFiles: string[] = [];
  check(await git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."],
    nulRecords((record) => {
      const path = record.subarray(3);
      if (record[0] === 0x3f && record[1] === 0x3f) hash.update(path).update("\0");
      if (workingFiles.length < MAX_FILES) workingFiles.push(path.toString("utf8").slice(prefix.length));
    })));
  return { head, fingerprint: hash.digest("hex"), workingFiles };
}

export async function describeGitDrift(
  workspace: string,
  previous: GitState | null,
  current: WorkspaceGitState | null,
): Promise<string> {
  if (!previous || !current || (previous.head === current.head && previous.fingerprint === current.fingerprint)) {
    return "";
  }

  const files = new Set<string>();
  if (previous.head !== current.head) {
    const old = previous.head ?? await emptyTree(workspace);
    const next = current.head ?? await emptyTree(workspace);
    check(await git(workspace, ["diff", "--name-only", "-z", "--relative", "--no-renames", old, next, "--", "."],
      nulRecords((path) => { if (files.size < MAX_FILES) files.add(path.toString("utf8")); })));
  }
  for (const path of current.workingFiles) {
    if (files.size >= MAX_FILES) break;
    files.add(path);
  }
  return [
    "注意：自上一轮操作后，工作区状态已变化（当前 HEAD: " + (current.head?.slice(0, 12) ?? "未提交") + "）。",
    "变更文件：" + ([...files].map((path) => "./" + path.replace(/[\r\n]/g, " ")).join(", ") || "无可列出的文件"),
    "历史中的旧代码片段可能已过期，修改前请重新读取当前磁盘文件。",
    "历史中的测试和构建结论已作废，请重新验证。",
  ].join("\n");
}
