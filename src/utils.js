import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_AGENT_ID,
  MAX_VERSIONS_LIMIT,
  VERSION_TAG_PREFIX,
} from "./constants.js";

export function normalizeAgentId(value) {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  return trimmed || DEFAULT_AGENT_ID;
}

export function resolveDefaultAgentId(cfg) {
  const listed = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  const chosen = listed.find((entry) => entry?.default)?.id ?? listed[0]?.id;
  return normalizeAgentId(chosen);
}

export function listConfiguredAgentIds(cfg) {
  const ids = new Set([resolveDefaultAgentId(cfg)]);
  const listed = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  for (const entry of listed) {
    const id = normalizeAgentId(entry?.id);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

export function parseAgentIdFromSessionKey(sessionKey) {
  const match = typeof sessionKey === "string" ? sessionKey.match(/^agent:([^:]+):/) : null;
  return normalizeAgentId(match?.[1]);
}

export function normalizeThreadId(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

export function normalizeAccountId(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || "default";
}

export function normalizeTarget(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function addAlias(seen, value) {
  const normalized = normalizeTarget(value);
  if (!normalized) {
    return;
  }
  seen.add(normalized);
}

function stripKnownPrefix(value, prefix) {
  if (!value || !prefix) {
    return undefined;
  }
  const loweredValue = value.toLowerCase();
  const loweredPrefix = prefix.toLowerCase();
  if (!loweredValue.startsWith(loweredPrefix)) {
    return undefined;
  }
  const stripped = value.slice(prefix.length);
  return normalizeTarget(stripped);
}

export function expandTargetAliases(value, channelId) {
  const normalized = normalizeTarget(value);
  if (!normalized) {
    return [];
  }

  const seen = new Set();
  const queue = [normalized];
  const loweredChannelId =
    typeof channelId === "string" && channelId.trim() ? channelId.trim().toLowerCase() : "";

  while (queue.length > 0) {
    const candidate = normalizeTarget(queue.shift());
    if (!candidate || seen.has(candidate)) {
      continue;
    }

    addAlias(seen, candidate);
    addAlias(seen, candidate.toLowerCase());

    for (const prefix of [
      loweredChannelId ? `${loweredChannelId}:user:` : "",
      loweredChannelId ? `${loweredChannelId}:channel:` : "",
      loweredChannelId ? `${loweredChannelId}:chat:` : "",
      loweredChannelId ? `${loweredChannelId}:conversation:` : "",
      loweredChannelId ? `${loweredChannelId}:direct:` : "",
      loweredChannelId ? `${loweredChannelId}:` : "",
      "user:",
      "channel:",
      "chat:",
      "conversation:",
      "direct:",
    ]) {
      if (!prefix) {
        continue;
      }
      const stripped = stripKnownPrefix(candidate, prefix);
      if (stripped && !seen.has(stripped)) {
        queue.push(stripped);
      }
    }
  }

  const baseValues = [...seen].filter((entry) => !entry.includes(":"));
  for (const base of baseValues) {
    addAlias(seen, `user:${base}`);
    addAlias(seen, `channel:${base}`);
    addAlias(seen, `chat:${base}`);
    addAlias(seen, `conversation:${base}`);
    addAlias(seen, `direct:${base}`);
    if (loweredChannelId) {
      addAlias(seen, `${loweredChannelId}:${base}`);
      addAlias(seen, `${loweredChannelId}:user:${base}`);
      addAlias(seen, `${loweredChannelId}:channel:${base}`);
      addAlias(seen, `${loweredChannelId}:chat:${base}`);
      addAlias(seen, `${loweredChannelId}:conversation:${base}`);
      addAlias(seen, `${loweredChannelId}:direct:${base}`);
    }
  }

  return [...seen];
}

export function buildLooseRouteKey({ channelId, accountId, target }) {
  return `${channelId || ""}::${normalizeAccountId(accountId)}::${target || ""}`;
}

export function extractThreadIdFromInternalMessageContext(context) {
  const raw = context?.metadata?.threadId;
  return normalizeThreadId(raw);
}

export function pickRouteTargets(route) {
  const targets = new Set();
  for (const candidate of [route?.from, route?.to, route?.conversationId]) {
    const normalized = normalizeTarget(candidate);
    if (normalized) {
      targets.add(normalized);
    }
  }
  return [...targets];
}

export function extractTargetsFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") {
    return [];
  }
  const parts = sessionKey.split(":");
  if (parts.length < 6 || parts[0] !== "agent") {
    return [];
  }

  const routeKind = normalizeTarget(parts[4]);
  const routeValue = normalizeTarget(parts.slice(5).join(":"));
  if (!routeKind || !routeValue) {
    return [];
  }

  const targets = new Set([`${routeKind}:${routeValue}`, routeValue]);
  if (routeKind === "direct") {
    targets.add(`user:${routeValue}`);
    targets.add(`conversation:${routeValue}`);
  }
  if (routeKind === "channel" || routeKind === "group") {
    targets.add(`channel:${routeValue}`);
    targets.add(`chat:${routeValue}`);
    targets.add(`conversation:${routeValue}`);
  }
  return [...targets];
}

function collectTextFromContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = typeof block.text === "string" ? block.text.trim() : "";
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

export function summarizeMessage(message) {
  const text = collectTextFromContent(message?.content);
  if (text) {
    return compactSummary(text, 100);
  }
  if (message?.role === "assistant") {
    return "[assistant reply]";
  }
  if (message?.role === "user") {
    return "[user message]";
  }
  return "[message]";
}

export function compactSummary(text, maxChars = 100) {
  const normalized = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function isAssistantMessage(message) {
  return Boolean(message && typeof message === "object" && message.role === "assistant");
}

export function createVersionTag() {
  return `${VERSION_TAG_PREFIX}${crypto.randomBytes(5).toString("hex")}`;
}

export function parsePositiveLimit(raw) {
  if (raw == null || raw === "") {
    return null;
  }
  const value = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.min(value, MAX_VERSIONS_LIMIT);
}

export function ensureVersionTag(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith(VERSION_TAG_PREFIX) ? trimmed : `${VERSION_TAG_PREFIX}${trimmed}`;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeFileUtf8(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, data, "utf8");
}

export async function copyFileUtf8(source, target) {
  const data = await fs.readFile(source, "utf8");
  await writeFileUtf8(target, data);
}

export function formatUtcTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown time";
  }
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

export function stableStringify(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}
