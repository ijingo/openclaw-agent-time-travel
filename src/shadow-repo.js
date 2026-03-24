import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureGitRepository,
  gitCommitAll,
  gitHeadCommit,
  gitListFilesAtCommit,
  gitReadFileAtCommit,
} from "./git.js";
import { ensureDir, writeFileUtf8 } from "./utils.js";
import { listTrackedWorkspaceRelativePaths } from "./tracked-files.js";

async function listShadowWorkingFiles(repoDir) {
  const files = [];

  async function walk(currentDir) {
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }
      const absPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      files.push(path.relative(repoDir, absPath).split(path.sep).join("/"));
    }
  }

  await walk(repoDir);
  return files.toSorted();
}

async function removeEmptyParents(rootDir, startDir) {
  let currentDir = startDir;
  while (currentDir.startsWith(rootDir) && currentDir !== rootDir) {
    let entries = [];
    try {
      entries = await fs.readdir(currentDir);
    } catch {
      return;
    }
    if (entries.length > 0) {
      return;
    }
    await fs.rmdir(currentDir).catch(() => undefined);
    currentDir = path.dirname(currentDir);
  }
}

async function removeWorkspaceRelativePaths(rootDir, relPaths) {
  for (const relPath of relPaths) {
    const absPath = path.join(rootDir, relPath);
    await fs.rm(absPath, { force: true });
    await removeEmptyParents(rootDir, path.dirname(absPath));
  }
}

export async function syncShadowRepo(params) {
  const { repoDir, workspaceDir, reason, logger } = params;
  await ensureGitRepository(repoDir);

  const trackedRelPaths = await listTrackedWorkspaceRelativePaths(workspaceDir);
  const trackedSet = new Set(trackedRelPaths);
  const shadowFiles = await listShadowWorkingFiles(repoDir);

  for (const relPath of shadowFiles) {
    if (trackedSet.has(relPath)) {
      continue;
    }
    const absPath = path.join(repoDir, relPath);
    await fs.rm(absPath, { force: true });
    await removeEmptyParents(repoDir, path.dirname(absPath));
  }

  for (const relPath of trackedRelPaths) {
    const sourcePath = path.join(workspaceDir, relPath);
    const targetPath = path.join(repoDir, relPath);
    const data = await fs.readFile(sourcePath, "utf8");
    await writeFileUtf8(targetPath, data);
  }

  const commit = await gitCommitAll(repoDir, reason);
  if (commit && logger?.info) {
    logger.info(`time-travel shadow repo commit ${commit.slice(0, 10)} (${reason})`);
  }

  return {
    headCommit: (await gitHeadCommit(repoDir)) ?? commit,
    trackedRelPaths,
  };
}

export async function restoreWorkspaceFromShadowCommit(params) {
  const { repoDir, workspaceDir, commit } = params;
  const currentPaths = await listTrackedWorkspaceRelativePaths(workspaceDir);
  if (!commit) {
    await removeWorkspaceRelativePaths(workspaceDir, currentPaths);
    return;
  }

  const targetPaths = await gitListFilesAtCommit(repoDir, commit);
  const targetSet = new Set(targetPaths);

  await removeWorkspaceRelativePaths(
    workspaceDir,
    currentPaths.filter((relPath) => !targetSet.has(relPath)),
  );

  for (const relPath of targetPaths) {
    const data = await gitReadFileAtCommit(repoDir, commit, relPath);
    const absPath = path.join(workspaceDir, relPath);
    await ensureDir(path.dirname(absPath));
    await fs.writeFile(absPath, data, "utf8");
  }
}
