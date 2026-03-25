import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, writeFileUtf8 } from "./utils.js";

export function resolvePluginStateRoot(stateDir) {
  return path.join(stateDir, "plugins", "openclaw-time-travel");
}

export function resolveAgentStateDir(pluginStateRoot, agentId) {
  return path.join(pluginStateRoot, agentId);
}

export function resolveShadowRepoDir(agentStateDir) {
  return path.join(agentStateDir, "shadow-worktree");
}

export function resolveVersionsPath(agentStateDir) {
  return path.join(agentStateDir, "versions.jsonl");
}

export function resolveSnapshotDir(agentStateDir, tag) {
  return path.join(agentStateDir, "snapshots", tag.replace(/^#/, ""));
}

export async function appendVersionRecord(agentStateDir, record) {
  const filePath = resolveVersionsPath(agentStateDir);
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export async function loadVersionRecords(agentStateDir) {
  const filePath = resolveVersionsPath(agentStateDir);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const records = [];
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      try {
        records.push(JSON.parse(line));
      } catch {
        // Skip corrupt lines so one bad record does not break /versions or /rewind.
      }
    }
    return records;
  } catch {
    return [];
  }
}

export async function findVersionByTag(agentStateDir, tag) {
  const records = await loadVersionRecords(agentStateDir);
  return records.find((record) => record.tag === tag) ?? null;
}

export async function listVersionsForSession(agentStateDir, sessionKey, options = {}) {
  const { limit = 10, includeBackups = false } = options;
  const records = await loadVersionRecords(agentStateDir);
  return records
    .filter((record) => record.sessionKey === sessionKey)
    .filter((record) => includeBackups || record.kind !== "backup")
    .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))
    .slice(0, limit);
}

export async function writeSnapshotFiles(agentStateDir, tag, payload) {
  const snapshotDir = resolveSnapshotDir(agentStateDir, tag);
  await ensureDir(snapshotDir);

  if (typeof payload.transcript === "string") {
    await writeFileUtf8(path.join(snapshotDir, "transcript.jsonl"), payload.transcript);
  }

  await writeFileUtf8(
    path.join(snapshotDir, "meta.json"),
    `${JSON.stringify(payload.meta, null, 2)}\n`,
  );
}

export async function readTranscriptSnapshot(agentStateDir, tag) {
  const transcriptPath = path.join(resolveSnapshotDir(agentStateDir, tag), "transcript.jsonl");
  return await fs.readFile(transcriptPath, "utf8");
}
