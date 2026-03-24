import fs from "node:fs/promises";
import path from "node:path";
import { TRACKED_ROOT_MARKDOWN_FILES } from "./constants.js";

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkMarkdownFiles(rootDir, currentDir, acc) {
  let entries = [];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdownFiles(rootDir, absPath, acc);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const relPath = path.relative(rootDir, absPath).split(path.sep).join("/");
    acc.push(relPath);
  }
}

export async function listTrackedWorkspaceRelativePaths(workspaceDir) {
  const relPaths = [];

  for (const fileName of TRACKED_ROOT_MARKDOWN_FILES) {
    const absPath = path.join(workspaceDir, fileName);
    if (await pathExists(absPath)) {
      relPaths.push(fileName);
    }
  }

  await walkMarkdownFiles(workspaceDir, path.join(workspaceDir, "memory"), relPaths);
  return relPaths.toSorted();
}

export async function buildWorkspaceFingerprint(workspaceDir) {
  const relPaths = await listTrackedWorkspaceRelativePaths(workspaceDir);
  const parts = [];

  for (const relPath of relPaths) {
    const absPath = path.join(workspaceDir, relPath);
    const stat = await fs.stat(absPath);
    parts.push(`${relPath}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
  }

  return parts.join("|");
}

