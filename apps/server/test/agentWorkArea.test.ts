import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { workAreaScript } from "../src/agents/workarea";
import type {
  AgentWorkArea,
  WorkspaceEnvironment,
} from "../../../packages/core/src/index";
let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
it("checks a real worktree, refuses dirty and unpushed content, retains the base and branch after cleanup", () => {
  root = mkdtempSync(join(tmpdir(), "nexus-area-"));
  const base = join(root, "repo"),
    work = join(root, "nexus-agent", "test");
  mkdirSync(base);
  mkdirSync(join(root, "nexus-agent"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", base, ...args], { stdio: "pipe" }).toString();
  git("init");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  writeFileSync(join(base, "file"), "initial");
  git("add", ".");
  git("commit", "-m", "initial");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("worktree", "add", "-b", "nexus-agent/test", work);
  const area = {
    id: "a",
    agentId: "a",
    environmentId: "e",
    directory: work,
    kind: "worktree",
    branch: "nexus-agent/test",
    owned: true,
    createdAt: 1,
  } as AgentWorkArea;
  const environment = {
    workRoot: root,
    directory: base,
  } as WorkspaceEnvironment;
  const run = (remove = false) =>
    execFileSync("sh", ["-s"], {
      input: workAreaScript(area, environment, remove),
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();
  expect(JSON.parse(run())).toEqual({
    exists: true,
    dirty: false,
    unpushed: false,
  });
  writeFileSync(join(work, "untracked"), "keep");
  expect(() => run(true)).toThrow();
  expect(existsSync(join(work, "untracked"))).toBe(true);
  rmSync(join(work, "untracked"));
  writeFileSync(join(work, "file"), "change");
  execFileSync("git", ["-C", work, "commit", "-am", "change"], {
    stdio: "pipe",
  });
  expect(JSON.parse(run()).unpushed).toBe(true);
  expect(() => run(true)).toThrow();
  git("update-ref", "refs/remotes/origin/agent", "nexus-agent/test");
  run(true);
  expect(existsSync(work)).toBe(false);
  expect(existsSync(join(base, "file"))).toBe(true);
  expect(git("rev-parse", "nexus-agent/test").trim()).toHaveLength(40);
});
it("rejects symlink replacement, unmanaged paths and nonempty ordinary directories", () => {
  root = mkdtempSync(join(tmpdir(), "nexus-area-"));
  mkdirSync(join(root, "nexus-agent"));
  const work = join(root, "nexus-agent", "test"),
    external = join(root, "external");
  mkdirSync(external);
  writeFileSync(join(external, "private"), "keep");
  symlinkSync(external, work);
  const area = {
      directory: work,
      kind: "directory",
      owned: true,
    } as AgentWorkArea,
    environment = {
      workRoot: root,
      directory: join(root, "repo"),
    } as WorkspaceEnvironment;
  const run = () =>
    execFileSync("sh", ["-s"], {
      input: workAreaScript(area, environment, true),
      stdio: "pipe",
    });
  expect(() => run()).toThrow();
  expect(existsSync(join(external, "private"))).toBe(true);
  rmSync(work);
  mkdirSync(work);
  writeFileSync(join(work, "data"), "keep");
  expect(() => run()).toThrow();
  expect(() =>
    workAreaScript({ ...area, directory: external }, environment, true),
  ).toThrow();
});
