import { randomUUID } from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const build = "A";

export default definePluginEntry({
  id: "reload-probe",
  name: "Scheduled hook replacement proof",
  description: "Observe the real scheduled exec hook across plugin replacement.",
  register(api) {
    const instance = randomUUID();
    const mark = (phase, extra = {}) =>
      api.logger.info(
        JSON.stringify({
          probe: "reload-probe",
          phase,
          build,
          instance,
          pid: process.pid,
          atMs: Date.now(),
          ...extra,
        }),
      );
    if (!api.lifecycle?.onDispose) {
      throw new Error("Managed lifecycle unavailable");
    }
    mark("register");
    api.lifecycle.onDispose(() => mark("dispose"));
    api.on(
      "before_tool_call",
      (event, ctx) => {
        mark("hook", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          sessionKey: ctx.sessionKey,
        });
      },
      { matcher: ["exec"] },
    );
  },
});
