/**
 * Framework-free Magic Canvas interaction semantics shared by every host.
 * Components describe intent. Only a validated server result and verified
 * causal receipt can authorize model delivery and direct-submit completion.
 */

import {
  deepFreezeCanvasValue,
  isCanvasRecord as isUnknownRecord,
} from "./internal.js";

export const CANVAS_INTERACTION_PROTOCOL_VERSION = 1 as const;

export type CanvasInteractionProtocolMode = "legacy" | "v1";
export type CanvasInteractionInitiationSource =
  | "direct_user"
  | "autonomous"
  | "system"
  | "unknown";
export type CanvasInteractionDisposition =
  | "received"
  | "pending"
  | "committed"
  | "stale"
  | "superseded";
export type CanvasInteractionDeliveryPolicy =
  | "respond_interrupt"
  | "append_context"
  | "none";
export type CanvasDeliveryChannel = Exclude<
  CanvasInteractionDeliveryPolicy,
  "none"
>;
export type CanvasDeliveryReceiptStatus =
  | "accepted"
  | "duplicate_accepted"
  | "suppressed";
export type CanvasJsonPrimitive = string | number | boolean | null;
export type CanvasJsonValue =
  | CanvasJsonPrimitive
  | CanvasJsonValue[]
  | { [key: string]: CanvasJsonValue };

type CanvasInteractionAttemptFields = Readonly<{
  interaction_id: string;
  conversation_id: string;
  tool_call_id: string;
  component: string;
  component_version: string;
  type: string;
  value: CanvasJsonValue;
  initiation_source: CanvasInteractionInitiationSource;
  initiated_at: string;
  producer_revision: number;
  payload_digest: string;
  response_text?: string;
  metadata: Readonly<Record<string, CanvasJsonValue>>;
}>;

type CanvasInteractionAttemptDraftFields = Omit<
  CanvasInteractionAttemptFields,
  "payload_digest"
>;

type CanvasInteractionAttemptV1Draft = CanvasInteractionAttemptDraftFields &
  Readonly<{
    protocol_mode: "v1";
    protocol_version: typeof CANVAS_INTERACTION_PROTOCOL_VERSION;
  }>;

type CanvasInteractionAttemptLegacyDraft = CanvasInteractionAttemptDraftFields &
  Readonly<{
    protocol_mode: "legacy";
  }>;

export type CanvasInteractionAttemptV1 = CanvasInteractionAttemptFields &
  Readonly<{
    protocol_mode: "v1";
    protocol_version: typeof CANVAS_INTERACTION_PROTOCOL_VERSION;
    /** Opaque card proof; non-enumerable at runtime. */
    issued_card_capability: string;
  }>;

const legacyNegotiationBrand: unique symbol = Symbol("CanvasLegacyNegotiation");

/** Created only by parsing an authoritative negotiated protocol response. */
export type CanvasLegacyNegotiation = Readonly<{
  protocol_mode: "legacy";
  interaction_id: string;
  [legacyNegotiationBrand]: true;
}>;

const legacyAttemptBrand: unique symbol = Symbol("CanvasLegacyAttempt");

export type CanvasInteractionAttemptLegacy = CanvasInteractionAttemptFields &
  Readonly<{
    protocol_mode: "legacy";
    [legacyAttemptBrand]: true;
  }>;

export type CanvasInteractionAttempt =
  | CanvasInteractionAttemptV1
  | CanvasInteractionAttemptLegacy;

type CreateCanvasInteractionAttemptCommonInput = {
  interaction_id: string;
  conversation_id: string;
  tool_call_id: string;
  component: string;
  component_version: string;
  type: string;
  value: unknown;
  initiation_source: CanvasInteractionInitiationSource;
  initiated_at: string;
  producer_revision: number;
  response_text?: string;
  metadata?: Record<string, unknown>;
};

export type CreateCanvasInteractionAttemptInput =
  CreateCanvasInteractionAttemptCommonInput & {
    issued_card_capability: string;
    /** Producer-authored digest carried unchanged across the iframe boundary. */
    payload_digest: string;
  };

export type CreateCanvasLegacyInteractionAttemptInput =
  CreateCanvasInteractionAttemptCommonInput & {
    negotiation: CanvasLegacyNegotiation;
    /** Producer-authored digest carried unchanged across the iframe boundary. */
    payload_digest: string;
  };

export type CreateCanvasSystemInteractionAttemptInput = Omit<
  CreateCanvasInteractionAttemptCommonInput,
  "initiation_source" | "response_text" | "type"
> & {
  type: "clear" | "replacement";
  issued_card_capability: string;
};

/** The exact public JSON object hashed by producers and delivery adapters. */
export type CanvasInteractionDigestPayload = Readonly<{
  protocol_mode: CanvasInteractionProtocolMode;
  protocol_version: typeof CANVAS_INTERACTION_PROTOCOL_VERSION | null;
  interaction_id: string;
  conversation_id: string;
  tool_call_id: string;
  component: string;
  component_version: string;
  type: string;
  value: CanvasJsonValue;
  initiation_source: CanvasInteractionInitiationSource;
  initiated_at: string;
  producer_revision: number;
  response_text: string | null;
}>;

export type CanvasInteractionResult = {
  success: true;
  protocol_mode: CanvasInteractionProtocolMode;
  interaction_id: string;
  disposition: CanvasInteractionDisposition;
  delivery_policy: CanvasInteractionDeliveryPolicy;
  winning_interaction_id?: string;
  model_delivery_id?: string;
  retry_after_ms?: number;
  /** Opaque server proof; non-enumerable on parsed results. */
  delivery_authorization?: string;
};

export type CanvasRawDeliveryReceipt = Readonly<{
  protocol_version: typeof CANVAS_INTERACTION_PROTOCOL_VERSION;
  conversation_id: string;
  tool_call_id: string;
  interaction_id: string;
  model_delivery_id: string;
  channel: CanvasDeliveryChannel;
  receipt: CanvasDeliveryReceiptStatus;
  /** Opaque signed proof; non-enumerable on parsed receipts. */
  receipt_authorization: string;
}>;

const verifiedReceiptBrand: unique symbol = Symbol(
  "CanvasVerifiedDeliveryReceipt",
);

export type CanvasVerifiedDeliveryReceipt = CanvasRawDeliveryReceipt &
  Readonly<{ [verifiedReceiptBrand]: true }>;
export type CanvasDeliveryReceipt = CanvasVerifiedDeliveryReceipt;
export type CanvasDeliveryReceiptVerifier = (
  receipt: CanvasRawDeliveryReceipt,
) => boolean | Promise<boolean>;

export type CanvasInteractionTerminalDecision =
  | "immediate_candidate"
  | "deferred_candidate"
  | "nonterminal"
  | "none";
export type CanvasInteractionUiCompletion =
  | "complete"
  | "close"
  | "replace"
  | "preserve"
  | "none";
export type CanvasInteractionPolicy = {
  terminal: CanvasInteractionTerminalDecision;
  ui_completion: CanvasInteractionUiCompletion;
  persistence: "required";
  model_delivery: CanvasInteractionDeliveryPolicy;
};
export type CanvasInteractionPolicyInput = {
  protocol_mode?: CanvasInteractionProtocolMode;
  protocol_version?: unknown;
  component: string;
  type: string;
  initiation_source: CanvasInteractionInitiationSource | string;
  response_text?: string;
  result?: CanvasInteractionResult;
};

export type CanvasTerminalModelContext = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: {
    protocol_version: typeof CANVAS_INTERACTION_PROTOCOL_VERSION;
    interaction_id: string;
    conversation_id: string;
    tool_call_id: string;
    component: string;
    component_version: string;
    type: string;
    value: CanvasJsonValue;
    initiation_source: CanvasInteractionInitiationSource;
    initiated_at: string;
    producer_revision: number;
    payload_digest: string;
    disposition: CanvasInteractionDisposition;
    winning_interaction_id?: string;
    model_delivery_id?: string;
  };
};

const SUPPORTED_DIRECT_SUBMIT_COMPONENTS = new Set([
  "canvas.question",
  "canvas.input",
  "canvas.calendar",
  "canvas.scheduling_embed",
]);
const TERMINAL_ACTIONS = new Set([
  "submit",
  "skip",
  "dismiss",
  "timer",
  "clear",
  "replacement",
]);
const CONTEXT_ACTIONS = new Set(TERMINAL_ACTIONS);
const KNOWN_SOURCES = new Set(["direct_user", "autonomous", "system"]);
const ALL_SOURCES = new Set([...KNOWN_SOURCES, "unknown"]);
const HOST_ONLY_ACTIONS = new Set(["clear", "replacement"]);

/**
 * RFC-8785-compatible JSON subset for cross-language SHA-256.
 *
 * Inputs are finite JSON values composed of plain objects, dense arrays,
 * strings without lone UTF-16 surrogates, booleans, numbers, and null. Object
 * keys sort by UTF-16 code units. Strings and finite numbers use ECMAScript
 * JSON.stringify serialization (including -0 => 0 and exponent thresholds).
 * Symbols, accessors, sparse arrays, cycles, and exotic objects are rejected.
 */
export function canonicalizeCanvasPayload(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

export async function createCanvasPayloadDigest(value: unknown) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle)
    throw new Error("Web Crypto is required to digest a Canvas payload.");
  const bytes = new TextEncoder().encode(canonicalizeCanvasPayload(value));
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createCanvasInteractionDigestPayload(
  attempt:
    | CanvasInteractionAttempt
    | CanvasInteractionAttemptV1Draft
    | CanvasInteractionAttemptLegacyDraft,
): CanvasInteractionDigestPayload {
  assertCanvasResponseTextAllowed(
    attempt.component,
    attempt.type,
    attempt.initiation_source,
    attempt.response_text,
  );
  const payload: CanvasInteractionDigestPayload = {
    protocol_mode: attempt.protocol_mode,
    protocol_version:
      attempt.protocol_mode === "v1"
        ? CANVAS_INTERACTION_PROTOCOL_VERSION
        : null,
    interaction_id: requireNonempty(attempt.interaction_id),
    conversation_id: requireNonempty(attempt.conversation_id),
    tool_call_id: requireNonempty(attempt.tool_call_id),
    component: requireNonempty(attempt.component),
    component_version: requireNonempty(attempt.component_version),
    type: requireNonempty(attempt.type),
    value: cloneCanvasJsonValue(attempt.value),
    initiation_source: attempt.initiation_source,
    initiated_at: requireNonempty(attempt.initiated_at),
    producer_revision: attempt.producer_revision,
    response_text: attempt.response_text ?? null,
  };
  validateCausalRevision(payload.producer_revision);
  return deepFreezeCanvasValue(payload);
}

export function createProducerInteractionId(
  createUuid: () => string = () => {
    if (!globalThis.crypto?.randomUUID)
      throw new Error("Web Crypto is required to create a Canvas interaction.");
    return globalThis.crypto.randomUUID();
  },
) {
  const uuid = createUuid();
  if (!uuid) throw new Error("Canvas interaction identity cannot be empty.");
  return `ci_${uuid}`;
}

export async function createDeterministicSystemInteractionId(input: {
  conversation_id: string;
  tool_call_id: string;
  system_action: "clear" | "replacement";
  producer_revision: number;
}) {
  const digest = await createCanvasPayloadDigest({
    channel: "system_interaction",
    ...input,
  });
  return `ci_sys_${digest}`;
}

export async function createDeterministicModelDeliveryId(input: {
  conversation_id: string;
  tool_call_id: string;
  interaction_id: string;
  channel: CanvasDeliveryChannel;
}) {
  const digest = await createCanvasPayloadDigest({
    channel: "model_delivery",
    delivery_channel: input.channel,
    conversation_id: input.conversation_id,
    tool_call_id: input.tool_call_id,
    interaction_id: input.interaction_id,
  });
  return `cmd_${digest}`;
}

export async function createCanvasInteractionAttempt(
  input: CreateCanvasInteractionAttemptInput,
): Promise<CanvasInteractionAttemptV1> {
  assertCanvasProducerInteractionAllowed(input.type, input.initiation_source);
  validateAttemptInput(input);
  requireNonempty(input.issued_card_capability);
  requireNonempty(input.payload_digest);
  const base = {
    protocol_mode: "v1" as const,
    protocol_version: CANVAS_INTERACTION_PROTOCOL_VERSION,
    interaction_id: input.interaction_id,
    conversation_id: input.conversation_id,
    tool_call_id: input.tool_call_id,
    component: input.component,
    component_version: input.component_version,
    type: input.type,
    value: cloneCanvasJsonValue(input.value),
    initiation_source: input.initiation_source,
    initiated_at: input.initiated_at,
    producer_revision: input.producer_revision,
    ...(input.response_text === undefined
      ? {}
      : { response_text: input.response_text }),
    metadata: cloneCanvasJsonObject(input.metadata ?? {}),
  } satisfies CanvasInteractionAttemptV1Draft;
  const payload_digest = await createCanvasPayloadDigest(
    createCanvasInteractionDigestPayload(base),
  );
  if (payload_digest !== input.payload_digest)
    throw new Error(
      "Canvas producer payload digest does not match its payload.",
    );
  return finalizeCanvasV1Attempt(
    base,
    input.payload_digest,
    input.issued_card_capability,
  );
}

/**
 * Creates the only interactions whose digest legitimately originates at the
 * host. Producer-originated interactions must use
 * `createCanvasInteractionAttempt`, which verifies the producer's claim.
 */
export async function createCanvasSystemInteractionAttempt(
  input: CreateCanvasSystemInteractionAttemptInput,
): Promise<CanvasInteractionAttemptV1> {
  if (input.type !== "clear" && input.type !== "replacement")
    throw new Error(
      "Canvas host-originated interactions support only clear or replacement.",
    );
  const systemInput = {
    ...input,
    initiation_source: "system" as const,
  };
  validateAttemptInput(systemInput);
  requireNonempty(input.issued_card_capability);
  const base = {
    protocol_mode: "v1" as const,
    protocol_version: CANVAS_INTERACTION_PROTOCOL_VERSION,
    interaction_id: input.interaction_id,
    conversation_id: input.conversation_id,
    tool_call_id: input.tool_call_id,
    component: input.component,
    component_version: input.component_version,
    type: input.type,
    value: cloneCanvasJsonValue(input.value),
    initiation_source: "system" as const,
    initiated_at: input.initiated_at,
    producer_revision: input.producer_revision,
    metadata: cloneCanvasJsonObject(input.metadata ?? {}),
  } satisfies CanvasInteractionAttemptV1Draft;
  const payloadDigest = await createCanvasPayloadDigest(
    createCanvasInteractionDigestPayload(base),
  );
  return finalizeCanvasV1Attempt(
    base,
    payloadDigest,
    input.issued_card_capability,
  );
}

export function parseCanvasLegacyNegotiation(
  value: unknown,
  expectedInteractionId: string,
): CanvasLegacyNegotiation | null {
  const result = parseCanvasInteractionResult(value, expectedInteractionId);
  if (
    !result ||
    result.protocol_mode !== "legacy" ||
    result.disposition !== "committed" ||
    result.delivery_policy !== "respond_interrupt"
  )
    return null;
  return Object.freeze(
    Object.defineProperty(
      {
        protocol_mode: "legacy" as const,
        interaction_id: result.interaction_id,
      },
      legacyNegotiationBrand,
      { enumerable: false, value: true },
    ) as CanvasLegacyNegotiation,
  );
}

export async function createCanvasLegacyInteractionAttempt(
  input: CreateCanvasLegacyInteractionAttemptInput,
): Promise<CanvasInteractionAttemptLegacy> {
  if (input.negotiation[legacyNegotiationBrand] !== true)
    throw new Error("Canvas legacy mode was not authoritatively negotiated.");
  validateAttemptInput(input);
  requireNonempty(input.payload_digest);
  if (input.negotiation.interaction_id !== input.interaction_id)
    throw new Error(
      "Canvas legacy negotiation does not match the interaction identity.",
    );
  if (
    input.type !== "submit" ||
    input.initiation_source !== "direct_user" ||
    !SUPPORTED_DIRECT_SUBMIT_COMPONENTS.has(input.component) ||
    !input.response_text
  )
    throw new Error(
      "Legacy Canvas mode supports only a known direct-user submit.",
    );
  const base = {
    protocol_mode: "legacy" as const,
    interaction_id: input.interaction_id,
    conversation_id: input.conversation_id,
    tool_call_id: input.tool_call_id,
    component: input.component,
    component_version: input.component_version,
    type: input.type,
    value: cloneCanvasJsonValue(input.value),
    initiation_source: input.initiation_source,
    initiated_at: input.initiated_at,
    producer_revision: input.producer_revision,
    response_text: input.response_text,
    metadata: cloneCanvasJsonObject(input.metadata ?? {}),
  } satisfies CanvasInteractionAttemptLegacyDraft;
  const payload_digest = await createCanvasPayloadDigest(
    createCanvasInteractionDigestPayload(base),
  );
  if (payload_digest !== input.payload_digest)
    throw new Error(
      "Canvas producer payload digest does not match its payload.",
    );
  return deepFreezeCanvasValue(
    Object.defineProperty(
      { ...base, payload_digest: input.payload_digest },
      legacyAttemptBrand,
      {
        configurable: false,
        enumerable: false,
        writable: false,
        value: true,
      },
    ) as CanvasInteractionAttemptLegacy,
  );
}

function finalizeCanvasV1Attempt(
  base: CanvasInteractionAttemptV1Draft,
  payloadDigest: string,
  issuedCardCapability: string,
) {
  const attempt = Object.defineProperty(
    { ...base, payload_digest: payloadDigest },
    "issued_card_capability",
    {
      configurable: false,
      enumerable: false,
      writable: false,
      value: issuedCardCapability,
    },
  ) as CanvasInteractionAttemptV1;
  return deepFreezeCanvasValue(attempt);
}

export function isAuthoritativeCanvasLegacyAttempt(
  value: unknown,
): value is CanvasInteractionAttemptLegacy {
  return (
    isUnknownRecord(value) &&
    value.protocol_mode === "legacy" &&
    (value as CanvasInteractionAttemptLegacy)[legacyAttemptBrand] === true
  );
}

/** Pure default-silent resolver. Response text never grants speech. */
export function resolveCanvasInteractionPolicy(
  input: CanvasInteractionPolicyInput,
): CanvasInteractionPolicy {
  const sourceKnown = KNOWN_SOURCES.has(input.initiation_source);
  const actionKnown =
    TERMINAL_ACTIONS.has(input.type) ||
    input.type === "heartbeat" ||
    input.type === "error";
  const result = input.result;
  let modelDelivery: CanvasInteractionDeliveryPolicy = "none";
  if (
    sourceKnown &&
    actionKnown &&
    result &&
    isValidCanvasInteractionResult(result) &&
    result.disposition === "committed"
  ) {
    const directSubmit = isSupportedDirectSubmitIntent(
      input.component,
      input.type,
      input.initiation_source,
    );
    if (
      result.protocol_mode === "legacy" &&
      input.protocol_mode === "legacy" &&
      directSubmit &&
      result.delivery_policy === "respond_interrupt"
    ) {
      modelDelivery = "respond_interrupt";
    } else if (
      result.protocol_mode === "v1" &&
      input.protocol_mode === "v1" &&
      input.protocol_version === CANVAS_INTERACTION_PROTOCOL_VERSION
    ) {
      if (directSubmit && result.delivery_policy === "respond_interrupt")
        modelDelivery = "respond_interrupt";
      else if (
        !directSubmit &&
        CONTEXT_ACTIONS.has(input.type) &&
        result.delivery_policy === "append_context"
      )
        modelDelivery = "append_context";
    }
  }
  return {
    terminal: resolveTerminal(input.type, input.initiation_source),
    ui_completion: resolveUiCompletion(
      input.component,
      input.type,
      actionKnown && sourceKnown,
    ),
    persistence: "required",
    model_delivery: modelDelivery,
  };
}

export function buildCanvasTerminalModelContext(
  attempt: CanvasInteractionAttemptV1,
  result: CanvasInteractionResult,
): CanvasTerminalModelContext {
  const structuredContent: CanvasTerminalModelContext["structuredContent"] = {
    protocol_version: attempt.protocol_version,
    interaction_id: attempt.interaction_id,
    conversation_id: attempt.conversation_id,
    tool_call_id: attempt.tool_call_id,
    component: attempt.component,
    component_version: attempt.component_version,
    type: attempt.type,
    value: attempt.value,
    initiation_source: attempt.initiation_source,
    initiated_at: attempt.initiated_at,
    producer_revision: attempt.producer_revision,
    payload_digest: attempt.payload_digest,
    disposition: result.disposition,
    ...(result.winning_interaction_id
      ? { winning_interaction_id: result.winning_interaction_id }
      : {}),
    ...(result.model_delivery_id
      ? { model_delivery_id: result.model_delivery_id }
      : {}),
  };
  return {
    content: [
      {
        type: "text",
        text: `Magic Canvas ${attempt.component} ${attempt.type} committed for ${attempt.tool_call_id}.`,
      },
    ],
    structuredContent,
  };
}

export function parseCanvasInteractionResult(
  value: unknown,
  expectedInteractionId?: string,
): CanvasInteractionResult | null {
  if (!isValidCanvasInteractionResult(value)) return null;
  if (
    expectedInteractionId !== undefined &&
    value.interaction_id !== expectedInteractionId
  )
    return null;
  const result = {
    success: true as const,
    protocol_mode: value.protocol_mode,
    interaction_id: value.interaction_id,
    disposition: value.disposition,
    delivery_policy: value.delivery_policy,
    ...(typeof value.winning_interaction_id === "string"
      ? { winning_interaction_id: value.winning_interaction_id }
      : {}),
    ...(typeof value.model_delivery_id === "string"
      ? { model_delivery_id: value.model_delivery_id }
      : {}),
    ...(typeof value.retry_after_ms === "number"
      ? { retry_after_ms: value.retry_after_ms }
      : {}),
  } satisfies CanvasInteractionResult;
  if (typeof value.delivery_authorization !== "string")
    return Object.freeze(result);
  return Object.freeze(
    Object.defineProperty(result, "delivery_authorization", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: value.delivery_authorization,
    }) as CanvasInteractionResult,
  );
}

export function parseCanvasRawDeliveryReceipt(
  value: unknown,
): CanvasRawDeliveryReceipt | null {
  if (!isUnknownRecord(value)) return null;
  if (value.protocol_version !== CANVAS_INTERACTION_PROTOCOL_VERSION)
    return null;
  for (const key of [
    "conversation_id",
    "tool_call_id",
    "interaction_id",
    "model_delivery_id",
    "receipt_authorization",
  ] as const)
    if (typeof value[key] !== "string" || value[key].length === 0) return null;
  if (
    value.channel !== "respond_interrupt" &&
    value.channel !== "append_context"
  )
    return null;
  if (!isReceiptStatus(value.receipt)) return null;
  return Object.freeze(
    Object.defineProperty(
      {
        protocol_version: CANVAS_INTERACTION_PROTOCOL_VERSION,
        conversation_id: value.conversation_id,
        tool_call_id: value.tool_call_id,
        interaction_id: value.interaction_id,
        model_delivery_id: value.model_delivery_id,
        channel: value.channel,
        receipt: value.receipt,
      },
      "receipt_authorization",
      {
        configurable: false,
        enumerable: false,
        writable: false,
        value: value.receipt_authorization,
      },
    ) as CanvasRawDeliveryReceipt,
  );
}

export async function verifyCanvasDeliveryReceipt(
  receipt: CanvasRawDeliveryReceipt,
  verifier: CanvasDeliveryReceiptVerifier,
): Promise<CanvasVerifiedDeliveryReceipt | null> {
  if (!isRawDeliveryReceipt(receipt)) return null;
  try {
    if (!(await verifier(receipt))) return null;
  } catch {
    return null;
  }
  return Object.freeze(
    Object.defineProperties(
      { ...receipt },
      {
        receipt_authorization: {
          configurable: false,
          enumerable: false,
          writable: false,
          value: receipt.receipt_authorization,
        },
        [verifiedReceiptBrand]: {
          configurable: false,
          enumerable: false,
          writable: false,
          value: true,
        },
      },
    ) as CanvasVerifiedDeliveryReceipt,
  );
}

export function isVerifiedCanvasDeliveryReceipt(
  value: unknown,
): value is CanvasVerifiedDeliveryReceipt {
  return (
    isRawDeliveryReceipt(value) &&
    (value as CanvasVerifiedDeliveryReceipt)[verifiedReceiptBrand] === true
  );
}

export function isValidCanvasInteractionResult(
  value: unknown,
): value is CanvasInteractionResult {
  if (!isUnknownRecord(value) || value.success !== true) return false;
  if (value.protocol_mode !== "legacy" && value.protocol_mode !== "v1")
    return false;
  if (typeof value.interaction_id !== "string" || !value.interaction_id)
    return false;
  if (!isDisposition(value.disposition)) return false;
  if (!isDeliveryPolicy(value.delivery_policy)) return false;
  if (!isOptionalNonemptyString(value.winning_interaction_id)) return false;
  if (!isOptionalNonemptyString(value.model_delivery_id)) return false;
  if (!isOptionalNonemptyString(value.delivery_authorization)) return false;
  if (
    value.retry_after_ms !== undefined &&
    (typeof value.retry_after_ms !== "number" ||
      !Number.isFinite(value.retry_after_ms) ||
      value.retry_after_ms < 0)
  )
    return false;

  const winner = typeof value.winning_interaction_id === "string";
  const modelId = typeof value.model_delivery_id === "string";
  const authorization = typeof value.delivery_authorization === "string";
  const unsettled =
    value.disposition === "received" || value.disposition === "pending";
  if (value.retry_after_ms !== undefined && !unsettled) return false;
  if (value.protocol_mode === "legacy")
    return (
      value.disposition === "committed" &&
      value.delivery_policy === "respond_interrupt" &&
      !winner &&
      !modelId &&
      !authorization &&
      value.retry_after_ms === undefined
    );
  if (value.disposition === "received")
    return !winner && !modelId && !authorization;
  if (value.disposition === "pending")
    return (
      value.delivery_policy !== "respond_interrupt" &&
      !winner &&
      !modelId &&
      !authorization
    );
  if (value.disposition === "stale" || value.disposition === "superseded")
    return (
      value.delivery_policy === "none" && winner && !modelId && !authorization
    );
  if (winner) return false;
  return (
    (value.delivery_policy === "respond_interrupt" ||
      value.delivery_policy === "append_context") &&
    modelId &&
    authorization
  );
}

export function isSupportedDirectSubmitAttempt(
  attempt: CanvasInteractionAttempt,
) {
  return isSupportedDirectSubmitIntent(
    attempt.component,
    attempt.type,
    attempt.initiation_source,
  );
}

export function isSupportedDirectSubmitIntent(
  component: string,
  type: string,
  source: CanvasInteractionInitiationSource | string,
) {
  return (
    type === "submit" &&
    source === "direct_user" &&
    SUPPORTED_DIRECT_SUBMIT_COMPONENTS.has(component)
  );
}

/**
 * Enforces the only semantic shape that may request persona speech. This is
 * intentionally reusable at every trust boundary; producer constructors alone
 * cannot protect hosts from a forged iframe event or a hand-built public type.
 */
export function assertCanvasResponseTextAllowed(
  component: string,
  type: string,
  source: CanvasInteractionInitiationSource | string | undefined,
  responseText: string | undefined,
) {
  if (responseText === undefined) return;
  if (
    !responseText ||
    source === undefined ||
    !isSupportedDirectSubmitIntent(component, type, source)
  ) {
    throw new Error(
      "Canvas response text is allowed only for a supported direct-user submit.",
    );
  }
}

/**
 * Producer payloads describe iframe/user activity. Host lifecycle actions are
 * created only by `createCanvasSystemInteractionAttempt`, after the host has
 * selected the authoritative card capability and revision.
 */
export function assertCanvasProducerInteractionAllowed(
  type: string,
  source: CanvasInteractionInitiationSource | string | undefined,
) {
  if (source === "system" || HOST_ONLY_ACTIONS.has(type))
    throw new Error(
      "Canvas producer interactions cannot mint host-only system actions.",
    );
}

function resolveTerminal(
  type: string,
  source: CanvasInteractionInitiationSource | string,
): CanvasInteractionTerminalDecision {
  if (type === "heartbeat" || type === "error") return "nonterminal";
  if (!TERMINAL_ACTIONS.has(type) || !KNOWN_SOURCES.has(source)) return "none";
  if (
    source === "direct_user" &&
    (type === "submit" || type === "skip" || type === "dismiss")
  )
    return "immediate_candidate";
  return "deferred_candidate";
}

function resolveUiCompletion(
  component: string,
  type: string,
  actionKnown: boolean,
): CanvasInteractionUiCompletion {
  if (!actionKnown) return "preserve";
  if (component === "canvas.scheduling_embed" && type === "submit")
    return "preserve";
  if (type === "submit" || type === "skip") return "complete";
  if (type === "dismiss" || type === "timer" || type === "clear")
    return "close";
  if (type === "replacement") return "replace";
  if (type === "heartbeat") return "none";
  return "preserve";
}

function canonicalize(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw jsonCompatibilityError();
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || stack.has(value))
    throw jsonCompatibilityError();
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      if (
        Reflect.ownKeys(value).some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)),
        )
      )
        throw jsonCompatibilityError();
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw jsonCompatibilityError();
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor?.enumerable || !("value" in descriptor))
          throw jsonCompatibilityError();
        items.push(canonicalize(descriptor.value, stack));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw jsonCompatibilityError();
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
      throw jsonCompatibilityError();
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    ))
      if (!descriptor.enumerable || !("value" in descriptor))
        throw jsonCompatibilityError();
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        assertValidUnicode(key);
        return `${JSON.stringify(key)}:${canonicalize(record[key], stack)}`;
      })
      .join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function assertValidUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw jsonCompatibilityError();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw jsonCompatibilityError();
    }
  }
}

function cloneCanvasJsonValue(value: unknown): CanvasJsonValue {
  return JSON.parse(canonicalizeCanvasPayload(value)) as CanvasJsonValue;
}

function cloneCanvasJsonObject(
  value: Record<string, unknown>,
): Record<string, CanvasJsonValue> {
  const cloned = cloneCanvasJsonValue(value);
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object")
    throw jsonCompatibilityError();
  return cloned;
}

function validateAttemptInput(
  input: CreateCanvasInteractionAttemptCommonInput,
) {
  for (const value of [
    input.interaction_id,
    input.conversation_id,
    input.tool_call_id,
    input.component,
    input.component_version,
    input.type,
    input.initiated_at,
  ])
    requireNonempty(value);
  validateCausalRevision(input.producer_revision);
  if (!ALL_SOURCES.has(input.initiation_source))
    throw new Error("Canvas attempt initiation source must be known.");
  assertCanvasResponseTextAllowed(
    input.component,
    input.type,
    input.initiation_source,
    input.response_text,
  );
}

function validateCausalRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Canvas producer revision must be a non-negative integer.");
}

function requireNonempty(value: string) {
  if (!value)
    throw new Error("Canvas interaction causal fields cannot be empty.");
  return value;
}

function isRawDeliveryReceipt(
  value: unknown,
): value is CanvasRawDeliveryReceipt {
  if (!isUnknownRecord(value)) return false;
  return (
    value.protocol_version === CANVAS_INTERACTION_PROTOCOL_VERSION &&
    typeof value.conversation_id === "string" &&
    value.conversation_id.length > 0 &&
    typeof value.tool_call_id === "string" &&
    value.tool_call_id.length > 0 &&
    typeof value.interaction_id === "string" &&
    value.interaction_id.length > 0 &&
    typeof value.model_delivery_id === "string" &&
    value.model_delivery_id.length > 0 &&
    (value.channel === "respond_interrupt" ||
      value.channel === "append_context") &&
    isReceiptStatus(value.receipt) &&
    typeof value.receipt_authorization === "string" &&
    value.receipt_authorization.length > 0
  );
}

function jsonCompatibilityError() {
  return new TypeError(
    "Canvas payloads must be JSON-compatible and contain valid Unicode.",
  );
}

function isDisposition(value: unknown): value is CanvasInteractionDisposition {
  return (
    value === "received" ||
    value === "pending" ||
    value === "committed" ||
    value === "stale" ||
    value === "superseded"
  );
}

function isDeliveryPolicy(
  value: unknown,
): value is CanvasInteractionDeliveryPolicy {
  return (
    value === "respond_interrupt" ||
    value === "append_context" ||
    value === "none"
  );
}

function isReceiptStatus(value: unknown): value is CanvasDeliveryReceiptStatus {
  return (
    value === "accepted" ||
    value === "duplicate_accepted" ||
    value === "suppressed"
  );
}

function isOptionalNonemptyString(value: unknown) {
  return value === undefined || (typeof value === "string" && value.length > 0);
}
