import {
  ROUTE_STALE_MS,
} from "./constants.js";
import {
  buildLooseRouteKey,
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
    const candidates = new Set(
      [normalizeTarget(params.from), normalizeTarget(params.to)].filter(Boolean),
    );

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
      const routeTargets = pickRouteTargets(route);
      const matches = routeTargets.some((value) => candidates.has(value));
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
    return pickRouteTargets(route).map((target) =>
      buildLooseRouteKey({
        channelId: route.channelId,
        accountId: route.accountId,
        target,
      }),
    );
  }

  return {
    rememberInbound,
    getRoute,
    resolveSessionKeyForCommand,
    buildLooseRouteKeysForSession,
  };
}

