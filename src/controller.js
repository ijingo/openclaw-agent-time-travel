import fs from "node:fs/promises";
import {
  DEFAULT_VERSIONS_LIMIT,
  PENDING_TAG_TTL_MS,
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
  buildLooseRouteKey,
  compactSummary,
  createVersionTag,
  ensureDir,
  ensureVersionTag,
  formatUtcTimestamp,
  isAssistantMessage,
  listConfiguredAgentIds,
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

function appendTagToText(text, tag) {
  const trimmed = typeof text === "string" ? text.trimEnd() : "";
  if (!trimmed) {
    return text;
  }
  if (trimmed.includes(tag)) {
    return trimmed;
  }
  return `${trimmed}\n\n${tag}`;
}

export function createTimeTravelController(api) {
  const routing = createSessionRoutingIndex();
  const pluginStateRoot = resolvePluginStateRoot(api.runtime.state.resolveStateDir());
  const managers = new Map();
  const preparedVersions = new Map();
  const pendingRouteTags = new Map();
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

  function getPendingRouteQueue(routeKey) {
    let queue = pendingRouteTags.get(routeKey);
    if (!queue) {
      queue = [];
      pendingRouteTags.set(routeKey, queue);
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

  function cleanupPendingRouteTags(now = Date.now()) {
    for (const [routeKey, queue] of pendingRouteTags.entries()) {
      const filtered = queue.filter((entry) => now - entry.createdAt <= PENDING_TAG_TTL_MS);
      if (filtered.length === 0) {
        pendingRouteTags.delete(routeKey);
        continue;
      }
      pendingRouteTags.set(routeKey, filtered);
    }
  }

  function queuePreparedTagForRoute(sessionKey, tag, summary) {
    const routeKeys = routing.buildLooseRouteKeysForSession(sessionKey);
    if (routeKeys.length === 0) {
      return;
    }
    const createdAt = Date.now();
    for (const routeKey of routeKeys) {
      const queue = getPendingRouteQueue(routeKey);
      queue.push({ tag, sessionKey, createdAt, summary });
    }
    cleanupPendingRouteTags(createdAt);
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

  function buildMessageSendingRouteKeys(event, ctx) {
    const keys = new Set();
    for (const target of [event?.to, ctx?.conversationId]) {
      if (typeof target !== "string" || !target.trim()) {
        continue;
      }
      keys.add(
        buildLooseRouteKey({
          channelId: ctx.channelId,
          accountId: ctx.accountId,
          target,
        }),
      );
    }
    return [...keys];
  }

  function consumePendingRouteTag(candidateKeys) {
    let selected = null;

    for (const routeKey of candidateKeys) {
      const queue = pendingRouteTags.get(routeKey);
      if (!queue || queue.length === 0) {
        continue;
      }
      queue.sort((a, b) => a.createdAt - b.createdAt);
      const candidate = queue[0];
      if (!candidate) {
        continue;
      }
      if (!selected || candidate.createdAt < selected.createdAt) {
        selected = candidate;
      }
    }

    if (!selected) {
      return null;
    }

    for (const [routeKey, queue] of pendingRouteTags.entries()) {
      const filtered = queue.filter((entry) => entry.tag !== selected.tag);
      if (filtered.length === 0) {
        pendingRouteTags.delete(routeKey);
        continue;
      }
      if (filtered.length !== queue.length) {
        pendingRouteTags.set(routeKey, filtered);
      }
    }

    return selected;
  }

  function clearPreparedStateForSession(sessionKey) {
    if (!sessionKey) {
      return;
    }
    preparedVersions.delete(sessionKey);
    for (const [routeKey, queue] of pendingRouteTags.entries()) {
      const filtered = queue.filter((entry) => entry.sessionKey !== sessionKey);
      if (filtered.length === 0) {
        pendingRouteTags.delete(routeKey);
        continue;
      }
      pendingRouteTags.set(routeKey, filtered);
    }
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

  function resolveCurrentSessionKeyForCommand(ctx) {
    if (!ensureHooksEnabled()) {
      return null;
    }
    return routing.resolveSessionKeyForCommand({
      channel: ctx.channel,
      channelId: ctx.channelId ?? ctx.channel,
      accountId: ctx.accountId,
      from: ctx.from,
      to: ctx.to,
      messageThreadId: ctx.messageThreadId,
    });
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

    prepareAssistantVersion(sessionKey, message) {
      if (!sessionKey || !isAssistantMessage(message)) {
        return;
      }
      const queue = getPreparedQueue(sessionKey);
      const prepared = {
        tag: createVersionTag(),
        summary: summarizeMessage(message),
        createdAt: Date.now(),
      };
      queue.push(prepared);
      queuePreparedTagForRoute(sessionKey, prepared.tag, prepared.summary);
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

    handleMessageSending(event, ctx) {
      cleanupPendingRouteTags();
      const selected = consumePendingRouteTag(buildMessageSendingRouteKeys(event, ctx));
      if (!selected) {
        return undefined;
      }
      return {
        content: appendTagToText(event.content, selected.tag),
      };
    },

    async handleVersionsCommand(ctx) {
      if (!ensureHooksEnabled()) {
        return {
          text:
            "Time Travel requires `hooks.internal.enabled: true`.\n\n" +
            "Enable it in OpenClaw config, then retry.",
        };
      }

      const sessionKey = resolveCurrentSessionKeyForCommand(ctx);
      if (!sessionKey) {
        return {
          text:
            "No current routed session could be resolved for this conversation.\n\n" +
            "Send a normal message in this chat first, then retry `/versions`.",
        };
      }

      const rawArgs = (ctx.args ?? "").trim();
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
        lines.push(
          `- ${version.tag} | ${formatUtcTimestamp(version.createdAt)} | git ${shadow} | ${version.summary}`,
        );
      }

      return { text: lines.join("\n") };
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

      const sessionKey = resolveCurrentSessionKeyForCommand(ctx);
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
