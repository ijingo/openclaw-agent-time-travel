import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureDir } from "./utils.js";

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "OpenClaw Time Travel",
  GIT_AUTHOR_EMAIL: "time-travel@openclaw.local",
  GIT_COMMITTER_NAME: "OpenClaw Time Travel",
  GIT_COMMITTER_EMAIL: "time-travel@openclaw.local",
  LC_ALL: "C",
};

export async function runGit(args, options = {}) {
  const { cwd, allowFailure = false } = options;
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: GIT_ENV,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
    };
  } catch (error) {
    if (allowFailure) {
      return {
        ok: false,
        stdout: (error.stdout ?? "").trim(),
        stderr: (error.stderr ?? "").trim(),
      };
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${reason}`);
  }
}

export async function ensureGitRepository(repoDir) {
  await ensureDir(repoDir);

  const gitDir = path.join(repoDir, ".git");
  try {
    const stat = await fs.stat(gitDir);
    if (stat.isDirectory()) {
      return;
    }
  } catch {
    // continue
  }

  await runGit(["init", "--initial-branch=main"], { cwd: repoDir });
  await runGit(["config", "user.name", GIT_ENV.GIT_AUTHOR_NAME], { cwd: repoDir });
  await runGit(["config", "user.email", GIT_ENV.GIT_AUTHOR_EMAIL], { cwd: repoDir });
}

export async function gitHasChanges(repoDir) {
  const result = await runGit(["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoDir,
  });
  return Boolean(result.stdout);
}

export async function gitCommitAll(repoDir, message) {
  await runGit(["add", "-A", "."], { cwd: repoDir });
  const hasChanges = await gitHasChanges(repoDir);
  if (!hasChanges) {
    return null;
  }
  await runGit(["commit", "-m", message], { cwd: repoDir });
  return await gitHeadCommit(repoDir);
}

export async function gitHeadCommit(repoDir) {
  const result = await runGit(["rev-parse", "HEAD"], {
    cwd: repoDir,
    allowFailure: true,
  });
  return result.ok && result.stdout ? result.stdout : null;
}

export async function gitListFilesAtCommit(repoDir, commit) {
  const result = await runGit(["ls-tree", "-r", "--name-only", commit], { cwd: repoDir });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .toSorted();
}

export async function gitReadFileAtCommit(repoDir, commit, relPath) {
  const result = await runGit(["show", `${commit}:${relPath}`], { cwd: repoDir });
  return result.stdout;
}

