import fs from "node:fs/promises";
import {
  DEFAULT_VERSIONS_LIMIT,
  VERSION_KIND_ASSISTANT,
  VERSION_KIND_BACKUP,
  WORKSPACE_POLL_INTERVAL_MS,
} from "./constants.js";
import {
  syncShadowRepo,
  restoreWorkspaceFromShadowCommit,
} from "./shadow-repo.js";
import {
  appendVersionRecord,
  findVersionByTag,
  listVersionsForSession,
  readTranscriptSnapshot,
  resolveAgentStateDir,
  resolvePluginStateRoot,
  resolveShadowRepoDir,
  writeSnapshotFiles,
} from "./version-store.js";
import { buildWorkspaceFingerprint } from "./tracked-files.js";
import { createSessionRoutingIndex } from "./session-routing.js";
import {
  compactSummary,
  createVersionTag,
  ensureDir,
  ensureVersionTag,
  expandTargetAliases,
  formatUtcTimestamp,
  isAssistantMessage,
  listConfiguredAgentIds,
  normalizeAccountId,
  parseAgentIdFromSessionKey,
  parsePositiveLimit,
  resolveDefaultAgentId,
  summarizeMessage,
} from "./utils.js";

function clearSessionRuntimeFields(entry) {
  const next = { ...entry, updatedAt: Date.now() };
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "totalTokensFresh",
    "estimatedCostUsd",
    "cacheRead",
    "cacheWrite",
    "contextTokens",
    "compactionCount",
    "memoryFlushAt",
    "memoryFlushCompactionCount",
    "memoryFlushContextHash",
    "systemPromptReport",
  ]) {
    delete next[key];
  }
  return next;
}

function collectCommandTargetCandidates(ctx) {
  const candidates = new Set();
  for (const raw of [ctx?.senderId, ctx?.from, ctx?.to]) {
    if (typeof raw !== "string" || !raw.trim()) {
      continue;
    }
    for (const alias of expandTargetAliases(raw, ctx?.channelId ?? ctx?.channel)) {
      candidates.add(alias);
    }
  }
  return candidates;
}

export function createTimeTravelController(api) {
  const routing = createSessionRoutingIndex();
  const pluginStateRoot = resolvePluginStateRoot(api.runtime.state.resolveStateDir());
  const managers = new Map();
  const preparedVersions = new Map();
  let transcriptUnsubscribe = null;
  let pollTimer = null;

  function logInfo(message) {
    api.logger.info?.(message);
  }

  function logWarn(message) {
    api.logger.warn?.(message);
  }

  function ensureHooksEnabled() {
    return api.config?.hooks?.internal?.enabled === true;
  }

  function getPreparedQueue(sessionKey) {
    let queue = preparedVersions.get(sessionKey);
    if (!queue) {
      queue = [];
      preparedVersions.set(sessionKey, queue);
    }
    return queue;
  }

  async function ensureManager(agentId) {
    const normalizedAgentId = agentId || resolveDefaultAgentId(api.config);
    let manager = managers.get(normalizedAgentId);
    if (manager) {
      return manager;
    }

    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, normalizedAgentId);
    const agentStateDir = resolveAgentStateDir(pluginStateRoot, normalizedAgentId);
    const shadowRepoDir = resolveShadowRepoDir(agentStateDir);

    manager = {
      agentId: normalizedAgentId,
      workspaceDir,
      agentStateDir,
      shadowRepoDir,
      lastFingerprint: null,
      syncInFlight: false,
      restoreInFlight: false,
    };

    await ensureDir(agentStateDir);
    managers.set(normalizedAgentId, manager);
    return manager;
  }

  async function syncManager(manager, reason) {
    if (manager.syncInFlight || manager.restoreInFlight) {
      return null;
    }
    manager.syncInFlight = true;
    try {
      const result = await syncShadowRepo({
        repoDir: manager.shadowRepoDir,
        workspaceDir: manager.workspaceDir,
        reason,
        logger: api.logger,
      });
      manager.lastFingerprint = await buildWorkspaceFingerprint(manager.workspaceDir);
      return result;
    } finally {
      manager.syncInFlight = false;
    }
  }

  function resolveSessionStoreEntry(store, sessionKey) {
    if (!store || typeof store !== "object" || !sessionKey) {
      return {
        key: sessionKey,
        entry: undefined,
      };
    }

    const directKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
    const normalizedKey = directKey.toLowerCase();
    const exactEntry = store[directKey];
    if (exactEntry) {
      return {
        key: directKey,
        entry: exactEntry,
      };
    }
    const normalizedEntry = store[normalizedKey];
    if (normalizedEntry) {
      return {
        key: normalizedKey,
        entry: normalizedEntry,
      };
    }

    for (const [candidateKey, candidateEntry] of Object.entries(store)) {
      if (candidateKey.toLowerCase() !== normalizedKey) {
        continue;
      }
      return {
        key: candidateKey,
        entry: candidateEntry,
      };
    }

    return {
      key: directKey || normalizedKey,
      entry: undefined,
    };
  }

  function clearPreparedStateForSession(sessionKey) {
    if (!sessionKey) {
      return;
    }
    preparedVersions.delete(sessionKey);
  }

  async function syncAgentWorkspace(agentId, reason) {
    const manager = await ensureManager(agentId);
    return await syncManager(manager, reason);
  }

  async function captureVersionRecord(params) {
    const {
      sessionKey,
      tag,
      kind,
      summary,
      transcriptPath,
      messageId,
      rewindOf,
    } = params;
    const agentId = parseAgentIdFromSessionKey(sessionKey);
    const manager = await ensureManager(agentId);
    const shadow = await syncManager(manager, `time-travel:${kind}:${tag}`);
    const transcript = await fs.readFile(transcriptPath, "utf8");
    const storePath = api.runtime.agent.session.resolveStorePath(api.config?.session?.store, {
      agentId,
    });
    const store = api.runtime.agent.session.loadSessionStore(storePath, { skipCache: true });
    const { entry: sessionEntry } = resolveSessionStoreEntry(store, sessionKey);

    const record = {
      tag,
      kind,
      agentId,
      sessionKey,
      sessionId: sessionEntry?.sessionId,
      sessionFile: transcriptPath,
      messageId,
      createdAt: Date.now(),
      shadowCommit: shadow?.headCommit ?? null,
      summary: compactSummary(summary || "[snapshot]", 100),
      rewindOf: rewindOf ?? null,
    };

    await writeSnapshotFiles(manager.agentStateDir, tag, {
      transcript,
      meta: record,
    });
    await appendVersionRecord(manager.agentStateDir, record);
    return record;
  }

  async function captureBackupVersion(sessionKey, rewindOfTag) {
    const agentId = parseAgentIdFromSessionKey(sessionKey);
    const storePath = api.runtime.agent.session.resolveStorePath(api.config?.session?.store, {
      agentId,
    });
    const store = api.runtime.agent.session.loadSessionStore(storePath, { skipCache: true });
    const { entry: sessionEntry } = resolveSessionStoreEntry(store, sessionKey);
    if (!sessionEntry?.sessionFile) {
      return null;
    }
    const tag = createVersionTag();
    return await captureVersionRecord({
      sessionKey,
      tag,
      kind: VERSION_KIND_BACKUP,
      summary: `backup before rewind ${rewindOfTag}`,
      transcriptPath: sessionEntry.sessionFile,
      rewindOf: rewindOfTag,
    });
  }

  async function resolveCurrentSessionKeyForCommand(ctx) {
    if (!ensureHooksEnabled()) {
      return null;
    }
    const routed = routing.resolveSessionKeyForCommand({
      channel: ctx.channel,
      channelId: ctx.channelId ?? ctx.channel,
      accountId: ctx.accountId,
      senderId: ctx.senderId,
      from: ctx.from,
      to: ctx.to,
      messageThreadId: ctx.messageThreadId,
    });
    if (routed) {
      return routed;
    }

    const channelId = ctx.channelId ?? ctx.channel;
    const accountId = normalizeAccountId(ctx.accountId);
    const candidates = collectCommandTargetCandidates(ctx);
    let best = null;

    for (const agentId of listConfiguredAgentIds(api.config)) {
      let store;
      try {
        const storePath = api.runtime.agent.session.resolveStorePath(api.config?.session?.store, {
          agentId,
        });
        store = api.runtime.agent.session.loadSessionStore(storePath, { skipCache: true });
      } catch (error) {
        logWarn(
          `time-travel could not scan session store for agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      for (const [sessionKey, entry] of Object.entries(store ?? {})) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const entryChannel =
          entry.lastChannel ||
          entry.deliveryContext?.channel ||
          entry.origin?.surface ||
          entry.origin?.provider;
        if (entryChannel !== channelId) {
          continue;
        }
        const entryAccountId = normalizeAccountId(
          entry.deliveryContext?.accountId || entry.origin?.accountId || entry.accountId,
        );
        if (entryAccountId !== accountId) {
          continue;
        }

        if (candidates.size > 0) {
          const entryTargets = new Set();
          for (const raw of [
            entry.lastTo,
            entry.deliveryContext?.to,
            entry.origin?.from,
            entry.origin?.to,
          ]) {
            if (typeof raw !== "string" || !raw.trim()) {
              continue;
            }
            for (const alias of expandTargetAliases(raw, channelId)) {
              entryTargets.add(alias);
            }
          }
          const matches = [...candidates].some((candidate) => entryTargets.has(candidate));
          if (!matches) {
            continue;
          }
        }

        const updatedAt = Number(entry.updatedAt ?? 0);
        if (!best || updatedAt > best.updatedAt) {
          best = {
            sessionKey,
            updatedAt,
          };
        }
      }
    }

    if (best?.sessionKey) {
      logInfo(`time-travel recovered routed session ${best.sessionKey} from session store`);
      return best.sessionKey;
    }

    return null;
  }

  async function rewindToVersion(sessionKey, version) {
    const agentId = parseAgentIdFromSessionKey(sessionKey);
    const manager = await ensureManager(agentId);
    const backup = await captureBackupVersion(sessionKey, version.tag);
    manager.restoreInFlight = true;
    try {
      const transcript = await readTranscriptSnapshot(manager.agentStateDir, version.tag);

      await restoreWorkspaceFromShadowCommit({
        repoDir: manager.shadowRepoDir,
        workspaceDir: manager.workspaceDir,
        commit: version.shadowCommit,
      });

      const storePath = api.runtime.agent.session.resolveStorePath(api.config?.session?.store, {
        agentId,
      });
      const store = api.runtime.agent.session.loadSessionStore(storePath, { skipCache: true });
      const { key: sessionStoreKey, entry: currentEntry } = resolveSessionStoreEntry(store, sessionKey);
      if (!currentEntry?.sessionFile) {
        throw new Error("Current session transcript path is unavailable.");
      }
      if (currentEntry.sessionId && version.sessionId && currentEntry.sessionId !== version.sessionId) {
        throw new Error("Refusing to rewind across different session ids in v1.");
      }

      await fs.writeFile(currentEntry.sessionFile, transcript, "utf8");
      store[sessionStoreKey] = clearSessionRuntimeFields(currentEntry);
      await api.runtime.agent.session.saveSessionStore(storePath, store);

      await syncManager(manager, `time-travel:rewind:${version.tag}`);
      clearPreparedStateForSession(sessionKey);

      return {
        ok: true,
        backupTag: backup?.tag ?? null,
      };
    } finally {
      manager.restoreInFlight = false;
    }
  }

  async function pollWorkspaces() {
    for (const agentId of listConfiguredAgentIds(api.config)) {
      const manager = await ensureManager(agentId);
      if (manager.restoreInFlight || manager.syncInFlight) {
        continue;
      }
      let fingerprint;
      try {
        fingerprint = await buildWorkspaceFingerprint(manager.workspaceDir);
      } catch {
        continue;
      }
      if (fingerprint === manager.lastFingerprint) {
        continue;
      }
      await syncManager(manager, "time-travel:workspace-poll");
    }
  }

  return {
    async start() {
      await ensureDir(pluginStateRoot);

      if (!ensureHooksEnabled()) {
        logWarn(
          'time-travel: hooks.internal.enabled is false; /versions, /rewind, and reply tagging will not work correctly.',
        );
      }

      for (const agentId of listConfiguredAgentIds(api.config)) {
        await ensureManager(agentId);
      }

      if (!transcriptUnsubscribe) {
        transcriptUnsubscribe = api.runtime.events.onSessionTranscriptUpdate((update) => {
          void (async () => {
            if (!update?.sessionKey || !isAssistantMessage(update?.message)) {
              return;
            }
            const queue = getPreparedQueue(update.sessionKey);
            const prepared = queue.shift() ?? {
              tag: createVersionTag(),
              summary: summarizeMessage(update.message),
              createdAt: Date.now(),
            };
            if (queue.length === 0) {
              preparedVersions.delete(update.sessionKey);
            }

            await captureVersionRecord({
              sessionKey: update.sessionKey,
              tag: prepared.tag,
              kind: VERSION_KIND_ASSISTANT,
              summary: prepared.summary,
              transcriptPath: update.sessionFile,
              messageId: update.messageId,
            });
          })().catch((error) => {
            logWarn(`time-travel transcript capture failed: ${String(error)}`);
          });
        });
      }

      if (!pollTimer) {
        pollTimer = setInterval(() => {
          void pollWorkspaces().catch((error) => {
            logWarn(`time-travel workspace poll failed: ${String(error)}`);
          });
        }, WORKSPACE_POLL_INTERVAL_MS);
      }

      await pollWorkspaces();
      logInfo("time-travel service started");
    },

    async stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      transcriptUnsubscribe?.();
      transcriptUnsubscribe = null;
      logInfo("time-travel service stopped");
    },

    handleInboundInternalHook(event) {
      if (!event?.sessionKey || event?.type !== "message" || event?.action !== "received") {
        return;
      }
      routing.rememberInbound(event);
    },

    handleBeforeMessageWrite(event, ctx) {
      const sessionKey = ctx?.sessionKey ?? event?.sessionKey;
      const message = event?.message;
      if (!sessionKey || !isAssistantMessage(message)) {
        return undefined;
      }
      const queue = getPreparedQueue(sessionKey);
      const prepared = {
        tag: createVersionTag(),
        summary: summarizeMessage(message),
        createdAt: Date.now(),
      };
      queue.push(prepared);
      return undefined;
    },

    async handleAfterToolCall(toolCtx) {
      const agentId =
        toolCtx?.agentId ||
        (toolCtx?.sessionKey ? parseAgentIdFromSessionKey(toolCtx.sessionKey) : null);
      if (!agentId) {
        return undefined;
      }
      await syncAgentWorkspace(
        agentId,
        `time-travel:after-tool:${toolCtx.toolName || "unknown"}`,
      );
      return undefined;
    },

    async handleVersionsCommand(ctx) {
      try {
        if (!ensureHooksEnabled()) {
          return {
            text:
              "Time Travel requires `hooks.internal.enabled: true`.\n\n" +
              "Enable it in OpenClaw config, then retry.",
          };
        }

        const sessionKey = await resolveCurrentSessionKeyForCommand(ctx);
        if (!sessionKey) {
          return {
            text:
              "No current routed session could be resolved for this conversation.\n\n" +
              "Send a normal message in this chat first, then retry `/versions`.",
          };
        }

        const rawArgs =
          typeof ctx.args === "string" ? ctx.args.trim() : String(ctx.args ?? "").trim();
        const limit = rawArgs ? parsePositiveLimit(rawArgs) : DEFAULT_VERSIONS_LIMIT;
        if (rawArgs && !limit) {
          return { text: "Usage: /versions [n]" };
        }

        const agentId = parseAgentIdFromSessionKey(sessionKey);
        const manager = await ensureManager(agentId);
        const versions = await listVersionsForSession(manager.agentStateDir, sessionKey, {
          limit: limit ?? DEFAULT_VERSIONS_LIMIT,
        });

        if (versions.length === 0) {
          return { text: "No rewindable versions exist for this conversation yet." };
        }

        const lines = [];
        lines.push(`Versions for ${sessionKey}:`);
        lines.push("");
        for (const version of versions) {
          const shadow = version.shadowCommit ? version.shadowCommit.slice(0, 7) : "none";
          const summary =
            typeof version.summary === "string" && version.summary.trim()
              ? version.summary.trim()
              : "[no summary]";
          lines.push(
            `- ${version.tag} | ${formatUtcTimestamp(version.createdAt)} | git ${shadow} | ${summary}`,
          );
        }

        return { text: lines.join("\n") };
      } catch (error) {
        logWarn(
          `time-travel /versions failed for channel=${ctx?.channel || "unknown"} sender=${ctx?.senderId || "unknown"}: ${error instanceof Error ? error.stack || error.message : String(error)}`,
        );
        return {
          text:
            "Time Travel hit an internal error while loading versions.\n\n" +
            "Retry once; if it still fails, check gateway logs for `time-travel /versions failed`.",
        };
      }
    },

    async handleRewindCommand(ctx) {
      if (!ensureHooksEnabled()) {
        return {
          text:
            "Time Travel requires `hooks.internal.enabled: true`.\n\n" +
            "Enable it in OpenClaw config, then retry.",
        };
      }

      const tag = ensureVersionTag((ctx.args ?? "").trim());
      if (!tag || tag === "#tt-") {
        return { text: "Usage: /rewind <tag>" };
      }

      const sessionKey = await resolveCurrentSessionKeyForCommand(ctx);
      if (!sessionKey) {
        return {
          text:
            "No current routed session could be resolved for this conversation.\n\n" +
            "Send a normal message in this chat first, then retry `/rewind`.",
        };
      }

      const agentId = parseAgentIdFromSessionKey(sessionKey);
      const manager = await ensureManager(agentId);
      const version = await findVersionByTag(manager.agentStateDir, tag);
      if (!version) {
        return { text: `Unknown time-travel tag: ${tag}` };
      }
      if (version.sessionKey !== sessionKey) {
        return {
          text:
            `${tag} does not belong to the current conversation.\n\n` +
            "V1 only rewinds tags from the current chat session.",
        };
      }

      const result = await rewindToVersion(sessionKey, version);
      if (!result.ok) {
        return { text: `Rewind failed for ${tag}.` };
      }

      const backupLine = result.backupTag
        ? `\nBackup of your previous state: ${result.backupTag}`
        : "";
      return {
        text:
          `Rewound this conversation and tracked workspace markdown files to ${tag}.` +
          backupLine,
      };
    },
  };
}
