import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createTimeTravelController } from "./src/controller.js";

export default definePluginEntry({
  id: "time-travel",
  name: "Time Travel",
  description: "Version and rewind agent conversation context plus tracked workspace markdown files.",
  register(api) {
    const controller = createTimeTravelController(api);

    api.registerService({
      id: "time-travel-service",
      start: async (ctx) => {
        await controller.start(ctx);
      },
      stop: async () => {
        await controller.stop();
      },
    });

    api.registerCommand({
      name: "versions",
      description: "List recent rewindable versions for the current conversation.",
      acceptsArgs: true,
      handler: async (ctx) => {
        return await controller.handleVersionsCommand(ctx);
      },
    });

    api.registerCommand({
      name: "rewind",
      description: "Restore the current conversation and tracked markdown files to an earlier tag.",
      acceptsArgs: true,
      handler: async (ctx) => {
        return await controller.handleRewindCommand(ctx);
      },
    });

    api.registerHook(
      "message:received",
      (event) => {
        controller.handleInboundInternalHook(event);
      },
      {
        name: "time-travel-route-index",
        description: "Track session-to-route bindings so reply tags and commands resolve the current session.",
      },
    );

    api.on("before_message_write", (event, ctx) => {
      controller.prepareAssistantVersion(ctx.sessionKey, event.message);
    });

    api.on("after_tool_call", (_event, ctx) => {
      return controller.handleAfterToolCall(ctx);
    });

    api.on("message_sending", (event, ctx) => {
      return controller.handleMessageSending(event, ctx);
    });
  },
});
