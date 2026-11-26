import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describeGitDrift, readGitState } from "../dist/core/git-state.js";
import { renderInjection } from "../dist/core/sanitizer.js";

function sandbox(t) {
  const cwd = mkdtempSync(join(tmpdir(), "agent-link-git-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test",
    "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" });
}

test("committed changes are reported even when the clean-tree fingerprints match", async (t) => {
  const repo = sandbox(t);
  git(repo, "init", "-q");
  const workspace = join(repo, "workspace 子");
  mkdirSync(workspace);
  const portable = process.platform === "win32" ? "auth & stale.ts" : "auth <stale>.ts";
  const source = join(workspace, portable);
  writeFileSync(source, "old\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "first");
  const previous = await readGitState(workspace);

  writeFileSync(source, "new\n");
  const uncommitted = await readGitState(workspace);
  assert.equal(previous.head, uncommitted.head);
  assert.notEqual(previous.fingerprint, uncommitted.fingerprint);
  assert.ok((await describeGitDrift(workspace, previous, uncommitted)).includes("变更文件：./" + portable));

  writeFileSync(join(repo, "other.txt"), "outside workspace\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "second");
  const current = await readGitState(workspace);
  assert.notEqual(previous.head, current.head);
  assert.equal(previous.fingerprint, current.fingerprint);
  assert.equal(await describeGitDrift(workspace, current, current), "");

  const state = await describeGitDrift(workspace, previous, current);
  assert.ok(state.includes("变更文件：./" + portable));
  assert.doesNotMatch(state, /other\.txt|workspace 子\//);
  const output = renderInjection("th_drift", [], state);
  assert.match(output, /^<workspace_state_reset>\n/);
  assert.match(output, /测试和构建结论已作废/);
  assert.doesNotMatch(output, /<stale>| & /);

  writeFileSync(join(repo, "other.txt"), "uncommitted and outside workspace\n");
  assert.equal((await readGitState(workspace)).fingerprint, current.fingerprint);
  writeFileSync(join(workspace, "local.txt"), "untracked\n");
  const dirty = await readGitState(workspace);
  const drift = await describeGitDrift(workspace, previous, dirty);
  assert.ok(drift.includes("./" + portable));
  assert.ok(drift.includes("./local.txt"));
  assert.doesNotMatch(drift, /other\.txt|workspace 子\//);
});

test("non-Git workspaces have no baseline; unborn Git tracks untracked paths beyond the display cap", async (t) => {
  const repo = sandbox(t);
  assert.equal(await readGitState(repo), null);
  assert.equal(await describeGitDrift(repo, { head: null, fingerprint: "old" }, null), "");
  git(repo, "init", "-q");
  for (let i = 0; i < 20; i++) writeFileSync(join(repo, "file-" + i + ".txt"), "");
  const previous = await readGitState(repo);
  writeFileSync(join(repo, "zzz.txt"), "");
  const current = await readGitState(repo);
  assert.equal(current.head, null);
  assert.notEqual(previous.fingerprint, current.fingerprint);

  const state = await describeGitDrift(repo, previous, current);
  assert.equal((state.match(/\.\//g) ?? []).length, 20);
  assert.doesNotMatch(state, /zzz\.txt/);
  assert.equal(await describeGitDrift(repo, null, current), "");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "first");
  const committed = await readGitState(repo);
  assert.match(await describeGitDrift(repo, current, committed), /变更文件：\.\/file-0\.txt/);
});
