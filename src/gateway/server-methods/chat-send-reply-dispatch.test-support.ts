import { vi } from "vitest";
import {
  appendTranscriptMessageSync,
  publishTranscriptUpdate,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { loadSessionEntry } from "../session-utils.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";

export async function createReplyTranscriptFixture(sessionKey = "agent:main:receipt") {
  const runId = "receipt-run";
  const scope = {
    agentId: "main",
    sessionId: "receipt-session",
    sessionKey,
    storePath: loadSessionEntry(sessionKey, { agentId: "main" }).storePath,
  };
  const sessionEntry = {
    sessionId: scope.sessionId,
    lifecycleRevision: "initial",
    updatedAt: 1,
  };
  await replaceSessionEntry(scope, sessionEntry);
  const append = async (messageId: string, message: Record<string, unknown>, parentId?: string) => {
    const persisted = attachSessionTranscriptRunId(message, runId);
    const result = appendTranscriptMessageSync(scope, {
      eventId: messageId,
      message: persisted,
      ...(parentId ? { parentId } : {}),
    });
    if (!result?.ok) {
      throw new Error("Expected committed receipt fixture message");
    }
    // Tool-bearing assistant updates intentionally have no top-level runId.
    await publishTranscriptUpdate(scope, { message: persisted, messageId });
  };
  const userTurnRecorder = createUserTurnTranscriptRecorder({
    input: {
      text: "Inspect the synthetic fixture.",
      idempotencyKey: `${runId}:user`,
    },
    target: { ...scope, sessionEntry },
  });
  const persistedInput = await userTurnRecorder.persistApproved();
  if (!persistedInput?.messageId) {
    throw new Error("Expected committed input admission");
  }
  let current = true;
  const abortController = new AbortController();
  const dispatch = createChatSendReplyDispatch({
    accountId: undefined,
    isAgentRunStarted: () => true,
    isRunCurrent: () => current,
    abortSignal: abortController.signal,
    logGateway: { ...createSubsystemLogger("test/chat-send-reply-dispatch"), warn: vi.fn() },
    session: {
      ...scope,
      entry: sessionEntry,
      backingSessionId: scope.sessionId,
      cfg: {},
      clientRunId: runId,
      sessionLoadOptions: { agentId: "main" },
    },
    userTurnRecorder,
  });
  return {
    scope,
    runId,
    inputId: persistedInput.messageId,
    append,
    dispatch,
    abortController,
    retire: () => {
      current = false;
    },
  };
}
