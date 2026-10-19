import { describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../../auto-reply/reply-payload.js";
import type { buildEmbeddedRunPayloads } from "./payloads.js";
import {
  assistantMessage,
  attemptResult,
  prepareAttempt,
} from "./terminal-preparation.test-support.js";

const payloadMocks = vi.hoisted(() => ({
  buildEmbeddedRunPayloads: vi.fn<typeof buildEmbeddedRunPayloads>(),
}));

vi.mock("./payloads.js", () => ({
  buildEmbeddedRunPayloads: payloadMocks.buildEmbeddedRunPayloads,
}));

describe("prepareEmbeddedRunTerminal transcript source", () => {
  it.each([true, false])(
    "recovers prompt-timeout final text with its own transcript source (source=%s)",
    async (hasSource) => {
      const completedText = "Completed answer block before the timeout.";
      const partialText = "Partial final response before the timeout.";
      const finalText = "Complete final response after the timeout.";
      const finalAssistant = {
        ...assistantMessage("stop"),
        content: [{ type: "text" as const, text: finalText }],
      };
      payloadMocks.buildEmbeddedRunPayloads.mockReturnValueOnce([
        { text: completedText },
        setReplyPayloadMetadata(
          { text: partialText },
          {
            assistantTranscriptSource: {
              occurrenceId: "partial-response",
              messageId: "partial-row",
            },
            assistantTranscriptAggregate: true,
          },
        ),
      ]);

      const prepared = await prepareAttempt({
        replyDeliveryState: "delivered",
        sourceReplyDeliveryState: "missing",
        attempt: attemptResult({
          terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
          assistantTexts: [completedText, partialText],
          lastAssistant: finalAssistant,
          currentAttemptAssistant: finalAssistant,
          currentAttemptCompletedAssistant: finalAssistant,
          ...(hasSource
            ? {
                assistantTranscriptSource: {
                  occurrenceId: "final-response",
                  messageId: "final-row",
                },
              }
            : {}),
        }),
        currentAttemptCompletedAssistant: finalAssistant,
        terminalState: {
          outcome: {
            reason: "hard_timeout",
            status: "timeout",
            timeoutPhase: "provider",
            providerStarted: true,
          },
          signalOwnedInterruption: false,
        },
      });

      expect(prepared.hasSuccessfulFinalAssistantAfterPromptTimeout).toBe(true);
      const recoveredAnswer = prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout?.[1];
      expect(recoveredAnswer?.text).toBe(finalText);
      expect(getReplyPayloadMetadata(recoveredAnswer!)?.assistantTranscriptSource).toEqual(
        hasSource ? { occurrenceId: "final-response", messageId: "final-row" } : undefined,
      );
      expect(
        getReplyPayloadMetadata(recoveredAnswer!)?.assistantTranscriptAggregate,
      ).toBeUndefined();
    },
  );
});
