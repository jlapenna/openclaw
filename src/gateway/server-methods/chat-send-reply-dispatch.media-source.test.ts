import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { sessionManagerReadTranscriptStart } from "../../agents/sessions/session-manager-current-turn.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { TINY_PNG_BASE64 } from "./chat-message.test-fixtures.js";
import { createReplyTranscriptFixture } from "./chat-send-reply-dispatch.test-support.js";

it.each(["identical", "streamed-tail", "superseded-media", "suppressed-append"] as const)(
  "finalizes distinct assistant media occurrences without index ownership (%s)",
  async (scenario) => {
    await withOpenClawTestState({ label: "chat-media-source" }, async (state) => {
      const { scope, runId, append, dispatch } = await createReplyTranscriptFixture();
      await fs.mkdir(state.statePath("media"), { recursive: true });
      const mediaUrl = state.statePath("media", "preview.png");
      await fs.writeFile(mediaUrl, Buffer.from(TINY_PNG_BASE64, "base64"));
      const canonical = new Map<string, Record<string, unknown>>();
      const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
      const manager = await SessionManager.openAsync(scope);
      await dispatch.runAgentMediaTranscript(
        { run: async (operation) => operation() },
        async () => {
          expect(
            dispatch.captureAgentTranscriptStart(
              runId,
              manager[sessionManagerReadTranscriptStart](),
            ),
          ).toBe(true);
          for (const messageId of ["first-response", "later-response"]) {
            const text = `Full identical answer.\nMEDIA:${mediaUrl}`;
            const message = {
              role: "assistant",
              responseId: messageId,
              content: [
                {
                  type: "text",
                  text,
                  textSignature: JSON.stringify({ v: 1, id: messageId, phase: "final_answer" }),
                },
              ],
            };
            const source = { occurrenceId: messageId, messageId: undefined as string | undefined };
            if (scenario !== "suppressed-append") {
              await append(messageId, message);
              source.messageId = messageId;
              canonical.set(messageId, message);
            }
            // Real retries can reuse the same index; media-only suppression and
            // streamed tails retain this physical occurrence, not text identity.
            const payload = setReplyPayloadMetadata(
              {
                text:
                  scenario === "superseded-media"
                    ? undefined
                    : scenario === "streamed-tail"
                      ? "answer."
                      : "Full identical answer.",
                mediaUrl,
                mediaUrls: [mediaUrl],
              },
              {
                assistantMessageIndex: 3,
                assistantTranscriptSource: source,
                assistantTranscriptMediaUrls: [mediaUrl],
              },
            );
            dispatcher.sendBlockReply(payload);
          }
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
        },
      );
      expect(dispatch.hasAppendedWebchatAgentMedia()).toBe(true);
      const messages = loadTranscriptEventsSync(scope).flatMap((event) =>
        isRecord(event) && isRecord(event.message) && event.message.role === "assistant"
          ? [{ id: event.id, message: event.message }]
          : [],
      );
      expect(messages).toHaveLength(2);
      for (const { id, message } of messages) {
        const display = message.openclawDisplayContent;
        expect(Array.isArray(display)).toBe(true);
        const blocks = Array.isArray(display) ? display : [];
        expect(blocks.filter((block) => isRecord(block) && block.type === "image")).toHaveLength(1);
        if (scenario === "suppressed-append") {
          expect(message.content).toEqual([]);
          expect(blocks.filter((block) => isRecord(block) && block.type === "text")).toEqual([]);
          expect(message.idempotencyKey).toMatch(/:assistant-media:(first|later)-response$/);
        } else {
          expect(message.content).toEqual(canonical.get(String(id))?.content);
          expect(message.responseId).toBe(id);
          expect(blocks.filter((block) => isRecord(block) && block.type === "text")).toEqual([
            { type: "text", text: "Full identical answer." },
          ]);
        }
      }
    });
  },
);
import fs from "node:fs/promises";
