// Interaction POST + AppBridge teardown helpers. Network and SDK-shutdown
// concerns live here so the React surface in `index.tsx` can stay focused on
// lifecycle wiring.

import type { CanvasConfig, CanvasInteractionEvent } from "./runtime.js";
import {
  assertCanvasResponseTextAllowed,
  type CanvasInteractionAttempt,
  type CanvasInteractionResult,
  parseCanvasInteractionResult,
} from "./semantic.js";

/**
 * The minimal AppBridge surface `closeBridge` needs, declared locally rather
 * than imported from `@modelcontextprotocol/ext-apps`. This keeps the package
 * free of any ext-apps type dependency, so it resolves under any consumer's
 * module resolution — a shipped global `declare module` augmentation does not
 * reliably merge from node_modules under a consumer's `nodenext`. Consumers
 * pass their real `AppBridge`, which structurally satisfies this. `close` is
 * optional because the published ext-apps types historically omit it even
 * though the transport implements it at runtime.
 */
export interface CanvasBridgeHandle {
  teardownResource(
    resource: Record<string, never>,
    options: { timeout: number },
  ): unknown;
  close?(): unknown;
}

const TAVUS_API_BASE_URL = "https://tavusapi.com";
const CANVAS_INTERACTION_TIMEOUT_MS = 5000;

export async function postInteraction(
  event: CanvasInteractionEvent | CanvasInteractionAttempt,
  canvasConfig: CanvasConfig,
): Promise<CanvasInteractionResult | null> {
  const endpoint = getInteractionEndpoint(event, canvasConfig);
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    CANVAS_INTERACTION_TIMEOUT_MS,
  );
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(serializeCanvasInteractionRequest(event)),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Magic Canvas interaction POST failed with ${response.status}.`,
      );
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      return null;
    }
    try {
      const value: unknown = body ? JSON.parse(body) : null;
      return parseCanvasInteractionResult(value, event.interaction_id);
    } catch {
      return null;
    }
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function serializeCanvasInteractionRequest(
  event: CanvasInteractionEvent | CanvasInteractionAttempt,
) {
  assertCanvasResponseTextAllowed(
    event.component,
    event.type,
    event.initiation_source,
    event.response_text,
  );
  const metadata: Record<string, unknown> = { ...event.metadata };
  // The causal namespace is host-owned; producer metadata cannot negotiate or
  // fabricate capability authority.
  delete metadata.causal;
  const protocolMode =
    "protocol_mode" in event ? event.protocol_mode : undefined;
  if (protocolMode === "v1") {
    const protocolVersion =
      "protocol_version" in event ? event.protocol_version : undefined;
    const issuedCardCapability =
      "issued_card_capability" in event
        ? event.issued_card_capability
        : undefined;
    if (
      protocolVersion !== 1 ||
      !event.initiation_source ||
      !event.initiated_at ||
      event.producer_revision === undefined ||
      !event.payload_digest ||
      !issuedCardCapability
    ) {
      throw new Error(
        "Magic Canvas v1 interaction causal envelope is incomplete.",
      );
    }
    metadata.causal = {
      protocol_mode: "v1",
      protocol_version: protocolVersion,
      issued_card_capability: issuedCardCapability,
      initiation_source: event.initiation_source,
      initiated_at: event.initiated_at,
      producer_revision: event.producer_revision,
      payload_digest: event.payload_digest,
      ...(event.response_text === undefined
        ? {}
        : { response_text: event.response_text }),
    };
  } else if (protocolMode === "legacy") {
    if (
      !event.initiation_source ||
      !event.initiated_at ||
      event.producer_revision === undefined ||
      !event.payload_digest
    ) {
      throw new Error(
        "Magic Canvas legacy interaction causal envelope is incomplete.",
      );
    }
    metadata.causal = {
      protocol_mode: "legacy",
      initiation_source: event.initiation_source,
      initiated_at: event.initiated_at,
      producer_revision: event.producer_revision,
      payload_digest: event.payload_digest,
      ...(event.response_text === undefined
        ? {}
        : { response_text: event.response_text }),
    };
  }

  return {
    interaction_id: event.interaction_id,
    tool_call_id: event.tool_call_id,
    component: event.component,
    component_version: event.component_version,
    type: event.type,
    value: event.value,
    metadata,
  };
}

export async function closeBridge(bridge: CanvasBridgeHandle) {
  try {
    await bridge.teardownResource({}, { timeout: 1000 });
  } catch {
    // The app may not acknowledge teardown; the bridge transport is closed below either way.
  }
  try {
    await bridge.close?.();
  } catch {
    // Transport may already be torn down by the iframe unmount; ignore.
  }
}

function getInteractionEndpoint(
  event: Pick<CanvasInteractionEvent, "conversation_id">,
  canvasConfig: CanvasConfig,
) {
  if (canvasConfig.interaction_url) {
    return canvasConfig.interaction_url.replace(
      "{conversation_id}",
      encodeURIComponent(event.conversation_id),
    );
  }

  const apiBaseUrl = (canvasConfig.api_base_url ?? TAVUS_API_BASE_URL).replace(
    /\/$/,
    "",
  );
  return `${apiBaseUrl}/v2/conversations/${encodeURIComponent(event.conversation_id)}/canvas/interactions`;
}
