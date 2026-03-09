import type { Bot } from "grammy";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import { clearHistoryEntriesIfEnabled } from "../auto-reply/reply/history.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { removeAckReactionAfterReply } from "../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../channels/logging.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { createTypingCallbacks } from "../channels/typing.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "../config/sessions.js";
import type { OpenClawConfig, ReplyToMode, TelegramAccountConfig } from "../config/types.js";
import { danger, logVerbose } from "../globals.js";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramBotOptions } from "./bot.js";
import { deliverReplies } from "./bot/delivery.js";
import type { TelegramStreamMode } from "./bot/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { renderTelegramHtmlText } from "./format.js";
import {
  createLaneDeliveryStateTracker,
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneName,
} from "./lane-delivery.js";
import {
  createTelegramReasoningStepState,
  splitTelegramReasoningText,
} from "./reasoning-lane-coordinator.js";
import { editMessageTelegram } from "./send.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

/** Minimum chars before sending first streaming message (improves push notification UX) */
const DRAFT_MIN_INITIAL_CHARS = 30;
const ANSWER_SEGMENT_NO_SPACE_BEFORE_RE = /^[,.;:!?)}\]]/;

function appendAnswerSegment(prefix: string, segment: string): string {
  if (!prefix) {
    return segment;
  }
  if (!segment) {
    return prefix;
  }
  if (
    /\s$/.test(prefix) ||
    /^\s/.test(segment) ||
    ANSWER_SEGMENT_NO_SPACE_BEFORE_RE.test(segment)
  ) {
    return `${prefix}${segment}`;
  }
  return `${prefix} ${segment}`;
}

async function resolveStickerVisionSupport(cfg: OpenClawConfig, agentId: string) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

export function pruneStickerMediaFromContext(
  ctxPayload: {
    MediaPath?: string;
    MediaUrl?: string;
    MediaType?: string;
    MediaPaths?: string[];
    MediaUrls?: string[];
    MediaTypes?: string[];
  },
  opts?: { stickerMediaIncluded?: boolean },
) {
  if (opts?.stickerMediaIncluded === false) {
    return;
  }
  const nextMediaPaths = Array.isArray(ctxPayload.MediaPaths)
    ? ctxPayload.MediaPaths.slice(1)
    : undefined;
  const nextMediaUrls = Array.isArray(ctxPayload.MediaUrls)
    ? ctxPayload.MediaUrls.slice(1)
    : undefined;
  const nextMediaTypes = Array.isArray(ctxPayload.MediaTypes)
    ? ctxPayload.MediaTypes.slice(1)
    : undefined;
  ctxPayload.MediaPaths = nextMediaPaths && nextMediaPaths.length > 0 ? nextMediaPaths : undefined;
  ctxPayload.MediaUrls = nextMediaUrls && nextMediaUrls.length > 0 ? nextMediaUrls : undefined;
  ctxPayload.MediaTypes = nextMediaTypes && nextMediaTypes.length > 0 ? nextMediaTypes : undefined;
  ctxPayload.MediaPath = ctxPayload.MediaPaths?.[0];
  ctxPayload.MediaUrl = ctxPayload.MediaUrls?.[0] ?? ctxPayload.MediaPath;
  ctxPayload.MediaType = ctxPayload.MediaTypes?.[0];
}

type DispatchTelegramMessageParams = {
  context: TelegramMessageContext;
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramCfg: TelegramAccountConfig;
  opts: Pick<TelegramBotOptions, "token">;
};

type AnswerSegmentState = {
  text: string;
  finalized: boolean;
  implicitAfterFinal: boolean;
};

type PendingAnswerFinalState = {
  payload: ReplyPayload;
  text: string;
};

type TelegramReasoningLevel = "off" | "on" | "stream";

function resolveTelegramReasoningLevel(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId: string;
}): TelegramReasoningLevel {
  const { cfg, sessionKey, agentId } = params;
  if (!sessionKey) {
    return "off";
  }
  try {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
    const level = entry?.reasoningLevel;
    if (level === "on" || level === "stream") {
      return level;
    }
  } catch {
    // Fall through to default.
  }
  return "off";
}

export const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  telegramCfg,
  opts,
}: DispatchTelegramMessageParams) => {
  const {
    ctxPayload,
    msg,
    chatId,
    isGroup,
    threadSpec,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
    statusReactionController,
  } = context;

  const draftMaxChars = Math.min(textLimit, 4096);
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const renderDraftPreview = (text: string) => ({
    text: renderTelegramHtmlText(text, { tableMode }),
    parseMode: "HTML" as const,
  });
  const accountBlockStreamingEnabled =
    typeof telegramCfg.blockStreaming === "boolean"
      ? telegramCfg.blockStreaming
      : cfg.agents?.defaults?.blockStreamingDefault === "on";
  const resolvedReasoningLevel = resolveTelegramReasoningLevel({
    cfg,
    sessionKey: ctxPayload.SessionKey,
    agentId: route.agentId,
  });
  const forceBlockStreamingForReasoning = resolvedReasoningLevel === "on";
  const streamReasoningDraft = resolvedReasoningLevel === "stream";
  const previewStreamingEnabled = streamMode !== "off";
  const canStreamAnswerDraft =
    previewStreamingEnabled && !accountBlockStreamingEnabled && !forceBlockStreamingForReasoning;
  const canStreamReasoningDraft = canStreamAnswerDraft || streamReasoningDraft;
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof msg.message_id === "number" ? msg.message_id : undefined;
  const draftMinInitialChars = DRAFT_MIN_INITIAL_CHARS;
  // Keep DM preview lanes on real message transport. Native draft previews still
  // require a draft->message materialize hop, and that overlap keeps reintroducing
  // a visible duplicate flash at finalize time.
  const useMessagePreviewTransportForDm = threadSpec?.scope === "dm" && canStreamAnswerDraft;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const archivedReasoningPreviewIds: number[] = [];
  const createDraftLane = (laneName: LaneName, enabled: boolean): DraftLaneState => {
    const stream = enabled
      ? createTelegramDraftStream({
          api: bot.api,
          chatId,
          maxChars: draftMaxChars,
          thread: threadSpec,
          previewTransport: useMessagePreviewTransportForDm ? "message" : "auto",
          replyToMessageId: draftReplyToMessageId,
          minInitialChars: draftMinInitialChars,
          renderText: renderDraftPreview,
          onSupersededPreview:
            laneName === "reasoning"
              ? (preview) => {
                  if (!archivedReasoningPreviewIds.includes(preview.messageId)) {
                    archivedReasoningPreviewIds.push(preview.messageId);
                  }
                }
              : undefined,
          log: logVerbose,
          warn: logVerbose,
        })
      : undefined;
    return {
      stream,
      lastPartialText: "",
      hasStreamedMessage: false,
    };
  };
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: createDraftLane("answer", canStreamAnswerDraft),
    reasoning: createDraftLane("reasoning", canStreamReasoningDraft),
  };
  const finalizedPreviewByLane: Record<LaneName, boolean> = {
    answer: false,
    reasoning: false,
  };
  const answerLane = lanes.answer;
  const reasoningLane = lanes.reasoning;
  let splitReasoningOnNextStream = false;
  const answerSegments: AnswerSegmentState[] = [];
  let answerBoundaryPending = false;
  const pendingAnswerFinals: PendingAnswerFinalState[] = [];
  const auxiliaryAnswerFinals: PendingAnswerFinalState[] = [];
  let bufferedAnswerFinal:
    | {
        payload: ReplyPayload;
        text: string;
      }
    | undefined;
  let draftLaneEventQueue = Promise.resolve();
  const reasoningStepState = createTelegramReasoningStepState();
  const enqueueDraftLaneEvent = (task: () => Promise<void>): Promise<void> => {
    const next = draftLaneEventQueue.then(task);
    draftLaneEventQueue = next.catch((err) => {
      logVerbose(`telegram: draft lane callback failed: ${String(err)}`);
    });
    return draftLaneEventQueue;
  };
  type SplitLaneSegment = { lane: LaneName; text: string };
  type SplitLaneSegmentsResult = {
    segments: SplitLaneSegment[];
    suppressedReasoningOnly: boolean;
  };
  const splitTextIntoLaneSegments = (text?: string): SplitLaneSegmentsResult => {
    const split = splitTelegramReasoningText(text);
    const segments: SplitLaneSegment[] = [];
    const suppressReasoning = resolvedReasoningLevel === "off";
    if (split.reasoningText && !suppressReasoning) {
      segments.push({ lane: "reasoning", text: split.reasoningText });
    }
    if (split.answerText) {
      segments.push({ lane: "answer", text: split.answerText });
    }
    return {
      segments,
      suppressedReasoningOnly:
        Boolean(split.reasoningText) && suppressReasoning && !split.answerText,
    };
  };
  const composeAnswerSegmentsText = () =>
    answerSegments.reduce((acc, segment) => appendAnswerSegment(acc, segment.text), "");
  const getCurrentAnswerText = () => composeAnswerSegmentsText();
  const getLastAnswerSegment = () => answerSegments[answerSegments.length - 1];
  const getUnfinalizedAnswerSegments = () => answerSegments.filter((segment) => !segment.finalized);
  const hasBufferedAnswerPayloadMetadata = (payload: ReplyPayload) => {
    const previewButtons = (
      payload.channelData?.telegram as { buttons?: TelegramInlineButtons } | undefined
    )?.buttons;
    return (
      Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0 || Boolean(previewButtons)
    );
  };
  const bufferAnswerFinal = (payload: ReplyPayload) => {
    const bufferedPayload =
      bufferedAnswerFinal &&
      hasBufferedAnswerPayloadMetadata(bufferedAnswerFinal.payload) &&
      !hasBufferedAnswerPayloadMetadata(payload)
        ? bufferedAnswerFinal.payload
        : payload;
    bufferedAnswerFinal = { payload: bufferedPayload, text: composeAnswerSegmentsText() };
  };
  const createAnswerSegment = (segmentStartsAfterFinal: boolean): AnswerSegmentState => {
    const segment: AnswerSegmentState = {
      text: "",
      finalized: false,
      implicitAfterFinal: segmentStartsAfterFinal && !answerBoundaryPending,
    };
    answerSegments.push(segment);
    answerBoundaryPending = false;
    return segment;
  };
  const commitAnswerFinal = (segment: AnswerSegmentState, final: PendingAnswerFinalState) => {
    segment.text = final.text;
    segment.finalized = true;
    segment.implicitAfterFinal = false;
    bufferAnswerFinal(final.payload);
  };
  const resolvePendingAnswerFinals = (opts?: { flushRemaining?: boolean }) => {
    if (pendingAnswerFinals.length === 0) {
      return;
    }

    let unresolvedSegments = getUnfinalizedAnswerSegments();
    if (unresolvedSegments.length === 0) {
      const lastSegment = getLastAnswerSegment();
      if (!lastSegment || answerBoundaryPending) {
        unresolvedSegments = [createAnswerSegment(false)];
      } else {
        auxiliaryAnswerFinals.push(...pendingAnswerFinals.splice(0));
        return;
      }
    }

    if (
      !opts?.flushRemaining &&
      unresolvedSegments.length > 1 &&
      pendingAnswerFinals.length < unresolvedSegments.length
    ) {
      return;
    }

    const assignCount = Math.min(pendingAnswerFinals.length, unresolvedSegments.length);
    const segmentOffset =
      opts?.flushRemaining && pendingAnswerFinals.length < unresolvedSegments.length
        ? unresolvedSegments.length - pendingAnswerFinals.length
        : 0;
    const assignedFinals = pendingAnswerFinals.splice(0, assignCount);
    const targetSegments = unresolvedSegments.slice(segmentOffset, segmentOffset + assignCount);

    for (const [index, segment] of targetSegments.entries()) {
      const final = assignedFinals[index];
      if (!final) {
        continue;
      }
      commitAnswerFinal(segment, final);
    }

    if (pendingAnswerFinals.length > 0) {
      auxiliaryAnswerFinals.push(...pendingAnswerFinals.splice(0));
    }
  };
  const updateAnswerSegmentFromPartial = (text: string) => {
    const lastSegment = getLastAnswerSegment();
    const segmentStartsAfterFinal = Boolean(lastSegment?.finalized);
    const needsNewSegment = answerBoundaryPending || !lastSegment || segmentStartsAfterFinal;
    const segment = needsNewSegment ? createAnswerSegment(segmentStartsAfterFinal) : lastSegment;
    if (text === segment.text) {
      return;
    }
    if (segment.text && segment.text.startsWith(text) && text.length < segment.text.length) {
      return;
    }
    segment.text = text;
    updateDraftFromPartial(answerLane, composeAnswerSegmentsText());
  };
  const queueAnswerFinal = (payload: ReplyPayload, text: string) => {
    pendingAnswerFinals.push({ payload, text });
    resolvePendingAnswerFinals();
  };
  const resetDraftLaneState = (lane: DraftLaneState) => {
    lane.lastPartialText = "";
    lane.hasStreamedMessage = false;
  };
  const updateDraftFromPartial = (lane: DraftLaneState, text: string | undefined) => {
    const laneStream = lane.stream;
    if (!laneStream || !text) {
      return;
    }
    if (text === lane.lastPartialText) {
      return;
    }
    // Mark that we've received streaming content (for forceNewMessage decision).
    lane.hasStreamedMessage = true;
    // Some providers briefly emit a shorter prefix snapshot (for example
    // "Sure." -> "Sure" -> "Sure."). Keep the longer preview to avoid
    // visible punctuation flicker.
    if (
      lane.lastPartialText &&
      lane.lastPartialText.startsWith(text) &&
      text.length < lane.lastPartialText.length
    ) {
      return;
    }
    lane.lastPartialText = text;
    laneStream.update(text);
  };
  const ingestDraftLaneSegments = async (text: string | undefined) => {
    const split = splitTextIntoLaneSegments(text);
    for (const segment of split.segments) {
      if (segment.lane === "reasoning") {
        reasoningStepState.noteReasoningHint();
        reasoningStepState.noteReasoningDelivered();
        updateDraftFromPartial(lanes.reasoning, segment.text);
        continue;
      }
      updateAnswerSegmentFromPartial(segment.text);
    }
  };
  const flushDraftLane = async (lane: DraftLaneState) => {
    if (!lane.stream) {
      return;
    }
    await lane.stream.flush();
  };

  const disableBlockStreaming = !previewStreamingEnabled
    ? true
    : forceBlockStreamingForReasoning
      ? false
      : typeof telegramCfg.blockStreaming === "boolean"
        ? !telegramCfg.blockStreaming
        : canStreamAnswerDraft
          ? true
          : undefined;

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "telegram",
    accountId: route.accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);

  // Handle uncached stickers: get a dedicated vision description before dispatch
  // This ensures we cache a raw description rather than a conversational response
  const sticker = ctxPayload.Sticker;
  if (sticker?.fileId && sticker.fileUniqueId && ctxPayload.MediaPath) {
    const agentDir = resolveAgentDir(cfg, route.agentId);
    const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
    let description = sticker.cachedDescription ?? null;
    if (!description) {
      description = await describeStickerImage({
        imagePath: ctxPayload.MediaPath,
        cfg,
        agentDir,
        agentId: route.agentId,
      });
    }
    if (description) {
      // Format the description with sticker context
      const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
        .filter(Boolean)
        .join(" ");
      const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

      sticker.cachedDescription = description;
      if (!stickerSupportsVision) {
        // Update context to use description instead of image
        ctxPayload.Body = formattedDesc;
        ctxPayload.BodyForAgent = formattedDesc;
        // Drop only the sticker attachment; keep replied media context if present.
        pruneStickerMediaFromContext(ctxPayload, {
          stickerMediaIncluded: ctxPayload.StickerMediaIncluded,
        });
      }

      // Cache the description for future encounters
      if (sticker.fileId) {
        cacheSticker({
          fileId: sticker.fileId,
          fileUniqueId: sticker.fileUniqueId,
          emoji: sticker.emoji,
          setName: sticker.setName,
          description,
          cachedAt: new Date().toISOString(),
          receivedFrom: ctxPayload.From,
        });
        logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
      } else {
        logVerbose(`telegram: skipped sticker cache (missing fileId)`);
      }
    }
  }

  const replyQuoteText =
    ctxPayload.ReplyToIsQuote && ctxPayload.ReplyToBody
      ? ctxPayload.ReplyToBody.trim() || undefined
      : undefined;
  const deliveryState = createLaneDeliveryStateTracker();
  const clearGroupHistory = () => {
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
    }
  };
  const deliveryBaseOptions = {
    chatId: String(chatId),
    accountId: route.accountId,
    token: opts.token,
    runtime,
    bot,
    mediaLocalRoots,
    replyToMode,
    textLimit,
    thread: threadSpec,
    tableMode,
    chunkMode,
    linkPreview: telegramCfg.linkPreview,
    replyQuoteText,
  };
  const applyTextToPayload = (payload: ReplyPayload, text: string): ReplyPayload => {
    if (payload.text === text) {
      return payload;
    }
    return { ...payload, text };
  };
  const sendPayload = async (payload: ReplyPayload) => {
    const result = await deliverReplies({
      ...deliveryBaseOptions,
      replies: [payload],
      onVoiceRecording: sendRecordVoice,
    });
    if (result.delivered) {
      deliveryState.markDelivered();
    }
    return result.delivered;
  };
  const deliverLaneText = createLaneTextDeliverer({
    lanes,
    finalizedPreviewByLane,
    draftMaxChars,
    applyTextToPayload,
    sendPayload,
    flushDraftLane,
    stopDraftLane: async (lane) => {
      await lane.stream?.stop();
    },
    editPreview: async ({ messageId, text, previewButtons }) => {
      await editMessageTelegram(chatId, messageId, text, {
        api: bot.api,
        cfg,
        accountId: route.accountId,
        linkPreview: telegramCfg.linkPreview,
        buttons: previewButtons,
      });
    },
    log: logVerbose,
    markDelivered: () => {
      deliveryState.markDelivered();
    },
  });
  const flushBufferedAnswerFinal = async () => {
    resolvePendingAnswerFinals({ flushRemaining: true });
    if (!bufferedAnswerFinal) {
      for (const auxiliaryFinal of auxiliaryAnswerFinals.splice(0)) {
        await sendPayload(auxiliaryFinal.payload);
      }
      return;
    }
    const { payload, text } = bufferedAnswerFinal;
    bufferedAnswerFinal = undefined;
    const previewButtons = (
      payload.channelData?.telegram as { buttons?: TelegramInlineButtons } | undefined
    )?.buttons;
    await deliverLaneText({
      laneName: "answer",
      text,
      payload,
      infoKind: "final",
      previewButtons,
    });
    for (const auxiliaryFinal of auxiliaryAnswerFinals.splice(0)) {
      await sendPayload(auxiliaryFinal.payload);
    }
    reasoningStepState.resetForNextStep();
  };

  let queuedFinal = false;

  if (statusReactionController) {
    void statusReactionController.setThinking();
  }

  const typingCallbacks = createTypingCallbacks({
    start: sendTyping,
    onStartError: (err) => {
      logTypingFailure({
        log: logVerbose,
        channel: "telegram",
        target: String(chatId),
        error: err,
      });
    },
  });

  let dispatchError: unknown;
  try {
    ({ queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        typingCallbacks,
        deliver: async (payload, info) => {
          if (info.kind === "final") {
            // Assistant callbacks are fire-and-forget; ensure queued boundary
            // rotations/partials are applied before final delivery mapping.
            await enqueueDraftLaneEvent(async () => {});
          }
          const previewButtons = (
            payload.channelData?.telegram as { buttons?: TelegramInlineButtons } | undefined
          )?.buttons;
          const split = splitTextIntoLaneSegments(payload.text);
          const segments = split.segments;
          const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;

          for (const segment of segments) {
            if (segment.lane === "reasoning") {
              reasoningStepState.noteReasoningHint();
              const result = await deliverLaneText({
                laneName: "reasoning",
                text: segment.text,
                payload,
                infoKind: info.kind,
                previewButtons,
                allowPreviewUpdateForNonFinal: true,
              });
              if (result !== "skipped") {
                reasoningStepState.noteReasoningDelivered();
              }
              continue;
            }
            if (info.kind === "final") {
              queueAnswerFinal(payload, segment.text);
              continue;
            }
            await deliverLaneText({
              laneName: "answer",
              text: composeAnswerSegmentsText(),
              sendText: segment.text,
              payload,
              infoKind: info.kind,
              previewButtons,
            });
          }
          if (segments.length > 0) {
            return;
          }
          if (split.suppressedReasoningOnly) {
            if (hasMedia) {
              const payloadWithoutSuppressedReasoning =
                typeof payload.text === "string" ? { ...payload, text: "" } : payload;
              await sendPayload(payloadWithoutSuppressedReasoning);
            }
            return;
          }

          if (info.kind === "final") {
            await answerLane.stream?.stop();
            await reasoningLane.stream?.stop();
            reasoningStepState.resetForNextStep();
          }
          const canSendAsIs =
            hasMedia || (typeof payload.text === "string" && payload.text.length > 0);
          if (!canSendAsIs) {
            return;
          }
          await sendPayload(payload);
        },
        onSkip: (_payload, info) => {
          if (info.reason !== "silent") {
            deliveryState.markNonSilentSkip();
          }
        },
        onError: (err, info) => {
          deliveryState.markNonSilentFailure();
          runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
        },
      },
      replyOptions: {
        skillFilter,
        disableBlockStreaming,
        onPartialReply:
          answerLane.stream || reasoningLane.stream
            ? (payload) =>
                enqueueDraftLaneEvent(async () => {
                  await ingestDraftLaneSegments(payload.text);
                })
            : undefined,
        onReasoningStream: reasoningLane.stream
          ? (payload) =>
              enqueueDraftLaneEvent(async () => {
                // Split between reasoning blocks only when the next reasoning
                // stream starts. Splitting at reasoning-end can orphan the active
                // preview and cause duplicate reasoning sends on reasoning final.
                if (splitReasoningOnNextStream) {
                  reasoningLane.stream?.forceNewMessage();
                  resetDraftLaneState(reasoningLane);
                  splitReasoningOnNextStream = false;
                }
                await ingestDraftLaneSegments(payload.text);
              })
          : undefined,
        onAssistantMessageStart: answerLane.stream
          ? () =>
              enqueueDraftLaneEvent(async () => {
                reasoningStepState.resetForNextStep();
                if (!getCurrentAnswerText()) {
                  return;
                }
                const lastSegment = getLastAnswerSegment();
                if (lastSegment && !lastSegment.finalized && lastSegment.implicitAfterFinal) {
                  lastSegment.implicitAfterFinal = false;
                  return;
                }
                answerBoundaryPending = true;
              })
          : undefined,
        onReasoningEnd: reasoningLane.stream
          ? () =>
              enqueueDraftLaneEvent(async () => {
                // Split when/if a later reasoning block begins.
                splitReasoningOnNextStream = reasoningLane.hasStreamedMessage;
              })
          : undefined,
        onToolStart: statusReactionController
          ? async (payload) => {
              await statusReactionController.setTool(payload.name);
            }
          : undefined,
        onModelSelected,
      },
    }));
    await flushBufferedAnswerFinal();
    if (queuedFinal && reasoningLane.hasStreamedMessage) {
      finalizedPreviewByLane.reasoning = true;
    }
  } catch (err) {
    dispatchError = err;
    runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
  } finally {
    // Upstream assistant callbacks are fire-and-forget; drain queued lane work
    // before stream cleanup so boundary rotations/materialization complete first.
    await draftLaneEventQueue;
    // Must stop() first to flush debounced content before clear() wipes state.
    const streamCleanupStates = new Map<
      NonNullable<DraftLaneState["stream"]>,
      { shouldClear: boolean }
    >();
    const lanesToCleanup: Array<{ laneName: LaneName; lane: DraftLaneState }> = [
      { laneName: "answer", lane: answerLane },
      { laneName: "reasoning", lane: reasoningLane },
    ];
    for (const laneState of lanesToCleanup) {
      const stream = laneState.lane.stream;
      if (!stream) {
        continue;
      }
      const shouldClear = !finalizedPreviewByLane[laneState.laneName];
      const existing = streamCleanupStates.get(stream);
      if (!existing) {
        streamCleanupStates.set(stream, { shouldClear });
        continue;
      }
      existing.shouldClear = existing.shouldClear && shouldClear;
    }
    for (const [stream, cleanupState] of streamCleanupStates) {
      await stream.stop();
      if (cleanupState.shouldClear) {
        await stream.clear();
      }
    }
    for (const messageId of archivedReasoningPreviewIds) {
      try {
        await bot.api.deleteMessage(chatId, messageId);
      } catch (err) {
        logVerbose(
          `telegram: archived reasoning preview cleanup failed (${messageId}): ${String(err)}`,
        );
      }
    }
  }
  let sentFallback = false;
  const deliverySummary = deliveryState.snapshot();
  if (
    dispatchError ||
    (!deliverySummary.delivered &&
      (deliverySummary.skippedNonSilent > 0 || deliverySummary.failedNonSilent > 0))
  ) {
    const fallbackText = dispatchError
      ? "Something went wrong while processing your request. Please try again."
      : EMPTY_RESPONSE_FALLBACK;
    const result = await deliverReplies({
      replies: [{ text: fallbackText }],
      ...deliveryBaseOptions,
    });
    sentFallback = result.delivered;
  }

  const hasFinalResponse = queuedFinal || sentFallback;

  if (statusReactionController && !hasFinalResponse) {
    void statusReactionController.setError().catch((err) => {
      logVerbose(`telegram: status reaction error finalize failed: ${String(err)}`);
    });
  }

  if (!hasFinalResponse) {
    clearGroupHistory();
    return;
  }

  if (statusReactionController) {
    void statusReactionController.setDone().catch((err) => {
      logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
    });
  } else {
    removeAckReactionAfterReply({
      removeAfterReply: removeAckAfterReply,
      ackReactionPromise,
      ackReactionValue: ackReactionPromise ? "ack" : null,
      remove: () => reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve(),
      onError: (err) => {
        if (!msg.message_id) {
          return;
        }
        logAckFailure({
          log: logVerbose,
          channel: "telegram",
          target: `${chatId}/${msg.message_id}`,
          error: err,
        });
      },
    });
  }
  clearGroupHistory();
};
