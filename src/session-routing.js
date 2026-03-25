import {
  ROUTE_STALE_MS,
} from "./constants.js";
import {
  buildLooseRouteKey,
  expandTargetAliases,
  extractTargetsFromSessionKey,
  extractThreadIdFromInternalMessageContext,
  normalizeAccountId,
  normalizeTarget,
  normalizeThreadId,
  pickRouteTargets,
} from "./utils.js";

export function createSessionRoutingIndex() {
  const routes = new Map();

  function prune(now = Date.now()) {
    for (const [sessionKey, route] of routes.entries()) {
      if (now - route.updatedAt > ROUTE_STALE_MS) {
        routes.delete(sessionKey);
      }
    }
  }

  function rememberInbound(event) {
    const context = event?.context ?? {};
    const route = {
      sessionKey: event.sessionKey,
      updatedAt: Date.now(),
      channelId: typeof context.channelId === "string" ? context.channelId : undefined,
      accountId: normalizeAccountId(context.accountId),
      from: normalizeTarget(context.from),
      to: normalizeTarget(context.metadata?.to),
      conversationId: normalizeTarget(context.conversationId),
      threadId: extractThreadIdFromInternalMessageContext(context),
    };
    if (!route.sessionKey || !route.channelId) {
      return;
    }
    routes.set(route.sessionKey, route);
    prune(route.updatedAt);
  }

  function getRoute(sessionKey) {
    prune();
    return routes.get(sessionKey) ?? null;
  }

  function resolveSessionKeyForCommand(params) {
    prune();
    const channelId = params.channelId || params.channel;
    const accountId = normalizeAccountId(params.accountId);
    const threadId = normalizeThreadId(params.messageThreadId);
    const candidates = new Set();
    for (const raw of [
      params.from,
      params.to,
      params.conversationId,
      params.senderId,
    ]) {
      const normalized = normalizeTarget(raw);
      if (!normalized) {
        continue;
      }
      for (const alias of expandTargetAliases(normalized, channelId)) {
        candidates.add(alias);
      }
    }

    let best = null;
    for (const route of routes.values()) {
      if (route.channelId !== channelId) {
        continue;
      }
      if (normalizeAccountId(route.accountId) !== accountId) {
        continue;
      }
      if (threadId && route.threadId && route.threadId !== threadId) {
        continue;
      }
      const routeTargets = pickRouteTargets(route).flatMap((value) =>
        expandTargetAliases(value, route.channelId),
      );
      const matches =
        candidates.size === 0 ? true : routeTargets.some((value) => candidates.has(value));
      if (!matches) {
        continue;
      }
      if (!best || route.updatedAt > best.updatedAt) {
        best = route;
      }
    }

    return best?.sessionKey ?? null;
  }

  function buildLooseRouteKeysForSession(sessionKey) {
    const route = getRoute(sessionKey);
    if (!route?.channelId) {
      return [];
    }
    const targets = new Set([
      ...pickRouteTargets(route),
      ...extractTargetsFromSessionKey(sessionKey),
    ]);
    const keys = new Set();
    for (const target of targets) {
      for (const alias of expandTargetAliases(target, route.channelId)) {
        keys.add(
          buildLooseRouteKey({
            channelId: route.channelId,
            accountId: route.accountId,
            target: alias,
          }),
        );
      }
    }
    return [...keys];
  }

  return {
    rememberInbound,
    getRoute,
    resolveSessionKeyForCommand,
    buildLooseRouteKeysForSession,
  };
}
