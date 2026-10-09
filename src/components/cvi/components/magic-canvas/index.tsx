import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { useObservableEvent, useSendAppMessage } from '../../hooks/cvi-events-hooks';

import styles from './magic-canvas.module.css';
import { closeBridge } from './bridge';
import {
	applyCanvasCommand,
	applyTaskStatusCommand,
	buildCanvasModelContextAppend,
	buildHostContext,
	CANVAS_LAYOUT_SLOTS,
	createCanvasInstance,
	extractCanvasInteraction,
	extractTextContent,
	isCanvasToolCallMessage,
	isRecord,
	MAGIC_CANVAS_MAX_HEIGHT_PX,
	normalizeInteraction,
	parseCanvasConfig,
	parseCanvasControlCommand,
	parseToolArguments,
	resolveCanvasLayout,
	resolveCanvasSidecarLayout,
	STATUS_STRIP_FALLBACK_MAX_WIDTH_PX,
	statusStripPlacement,
} from './runtime';
import type {
	CanvasDisplayMode,
	CanvasErrorCode,
	CanvasErrorEvent,
	CanvasInstance,
	CanvasInteractionEvent,
	CanvasLayoutSlot,
	CanvasModelContextUpdate,
	CanvasResolvedLayout,
	CanvasSidecarLayout,
	CanvasViewport,
	CanvasToolCallProperties,
	JsonRecord,
} from './runtime';

import {
	canvasSubmitTeardownDelayMs,
	createCanvasCompletionScheduler,
	deliverCanvasInteraction,
	NativeCanvasHost,
	resolveCanvasRenderer,
} from './native-host';
import type { CanvasRenderRegistry } from './native-host';

export {
	type CanvasErrorCode,
	type CanvasErrorEvent,
	type CanvasInteractionEvent,
	type CanvasSidecarLayout,
} from './runtime';
export {
	canvasRendererKey,
	NativeCanvasHost,
	resolveCanvasRenderer,
	type CanvasComponentRenderer,
	type CanvasRenderRegistry,
	type CanvasRendererProps,
} from './native-host';

export type MagicCanvasCallControlsRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

type MagicCanvasProps = {
	className?: string;
	callControlsRect?: MagicCanvasCallControlsRect;
	onInteraction?: (event: CanvasInteractionEvent) => void | Promise<void>;
	/**
	 * Error channel. Delivery is best-effort (PROD-5180): a failed interaction
	 * POST no longer blocks the card — `interaction_post_failed` arrives only
	 * after background retries exhaust, possibly AFTER the card has completed
	 * and unmounted. Handlers must not assume the card is still on screen.
	 */
	onError?: (event: CanvasErrorEvent) => void;
	onLayoutEffectChange?: (layout: CanvasSidecarLayout) => void;
	/**
	 * Optional registry of native renderers keyed by `"<component>@<version>"`.
	 * Matching instances render via NativeCanvasHost; otherwise the iframe
	 * sandbox is used unchanged (default-off — omit and behavior is identical).
	 */
	renderComponent?: CanvasRenderRegistry;
};

const MODEL_CONTEXT_RELAY_INTERVAL_MS = 1000;

// A slot resize arrives as a burst of ResizeObserver ticks; one host-context
// send per settled size is enough.
const AVAILABLE_HEIGHT_COALESCE_MS = 50;

// Floor for app-REPORTED heights. The runtime's MAGIC_CANVAS_MIN_HEIGHT_PX
// (240) is a layout default, not a floor for real reports — flooring there
// padded short components (e.g. a 182px input card) with dead space below
// the content. Real reports are trusted; this only guards degenerate values
// from a mid-load ResizeObserver tick. Mirrors the tavus-deployment host.
const CANVAS_REPORTED_HEIGHT_FLOOR_PX = 48;

const STATUS_STRIP_DEFAULT_HEIGHT_PX = 48;
const STATUS_STRIP_MAX_HEIGHT_PX = 160;

// Per-component iframe sandbox policy, owned by the host (not server-supplied).
// Default is locked-down allow-scripts; Calendly's scheduling_embed needs its
// own origin, popups, and form submission to complete a booking.
const DEFAULT_IFRAME_SANDBOX = 'allow-scripts';
const COMPONENT_IFRAME_SANDBOX: Record<string, string> = {
	'canvas.scheduling_embed': 'allow-scripts allow-same-origin allow-popups allow-forms',
	'canvas.text': 'allow-scripts allow-popups allow-popups-to-escape-sandbox',
};

// Trust a bridge message only when it comes from THIS iframe's LIVE
// contentWindow (read at message time, not captured earlier) and is JSON-RPC
// shaped: accepts the component's post-navigation messages while rejecting
// forged JSON-RPC from other frames and cross-talk between sibling canvases.
export function isTrustedCanvasFrameMessage(
	event: Pick<MessageEvent, 'source' | 'data'>,
	iframe: Pick<HTMLIFrameElement, 'contentWindow'>
): boolean {
	if (!iframe.contentWindow || event.source !== iframe.contentWindow) return false;
	const data = event.data as { jsonrpc?: unknown } | null | undefined;
	return Boolean(data) && typeof data === 'object' && data?.jsonrpc === '2.0';
}

// Host-side JSON-RPC transport for the component iframe. We connect
// SYNCHRONOUSLY, before the iframe navigates, to catch the app's
// `ui/initialize` handshake (fires during module-script execution, before
// `load`). The SDK's PostMessageTransport can't do this: it compares
// `event.source` against a window captured at construct time, the stale
// pre-navigation about:blank window, and would drop the handshake. This
// transport validates against the LIVE `iframe.contentWindow` at receive
// time. Mirrors the tavus-deployment host.
export class CanvasFrameTransport {
	onmessage?: (message: unknown) => void;
	onerror?: (error: Error) => void;
	onclose?: () => void;

	#iframe: HTMLIFrameElement;
	// `| undefined` (not the `?` optional marker): the TS->JS template
	// converter strips types but keeps the optional marker on private class
	// fields, which would emit invalid JS (`#listener?;`).
	#listener: ((event: MessageEvent) => void) | undefined = undefined;

	constructor(iframe: HTMLIFrameElement) {
		this.#iframe = iframe;
	}

	start(): Promise<void> {
		const listener = (event: MessageEvent) => {
			if (!isTrustedCanvasFrameMessage(event, this.#iframe)) return;
			this.onmessage?.(event.data);
		};
		this.#listener = listener;
		globalThis.addEventListener('message', listener);
		return Promise.resolve();
	}

	send(message: unknown): Promise<void> {
		// Same `"*"` target origin the SDK transport uses; the receiver validates
		// source rather than relying on a target-origin match (the sandboxed app
		// has an opaque origin).
		this.#iframe.contentWindow?.postMessage(message, '*');
		return Promise.resolve();
	}

	close(): Promise<void> {
		if (this.#listener) globalThis.removeEventListener('message', this.#listener);
		this.#listener = undefined;
		this.onclose?.();
		return Promise.resolve();
	}
}

// Navigate the iframe and wire the bridge connect. Connect synchronously,
// BEFORE the iframe navigates: the app sends `ui/initialize` during
// module-script execution, before `load`, and postMessage does not queue for
// late listeners, so attaching only on `load` makes connect() time out
// ("Unable to connect to host"). `connectBridge` is idempotent, so the `load`
// listener stays as a rare-case fallback. Returns the listener disposer.
export function wireCanvasFrameConnect(
	iframe: Pick<HTMLIFrameElement, 'addEventListener' | 'removeEventListener'> & { src: string },
	targetHref: string,
	connectBridge: () => void
): () => void {
	iframe.addEventListener('load', connectBridge);
	iframe.src = targetHref;
	connectBridge();
	return () => iframe.removeEventListener('load', connectBridge);
}

export const MagicCanvas = memo(
	({
		className,
		callControlsRect,
		onInteraction,
		onError,
		onLayoutEffectChange,
		renderComponent,
	}: MagicCanvasProps) => {
		const [instances, setInstances] = useState<CanvasInstance[]>([]);
		const [statusStrip, setStatusStrip] = useState<CanvasInstance | null>(null);
		const viewport = useCanvasViewport();
		const visualViewportFrame = useVisualViewportFrame();
		const onErrorRef = useRef(onError);
		const instancesRef = useRef(instances);
		const statusStripRef = useRef(statusStrip);

		useEffect(() => {
			onErrorRef.current = onError;
		}, [onError]);

		useEffect(() => {
			instancesRef.current = instances;
		}, [instances]);

		// A card's host is torn down and rebuilt whenever its layout slot changes,
		// so the host cannot tell "the card went away" from "the card moved".
		// Removal happens here, so liveness is answered here.
		const isInstanceLive = useCallback(
			(id: string) => instancesRef.current.some((item) => item.id === id),
			[]
		);

		const isStripInstanceLive = useCallback((id: string) => statusStripRef.current?.id === id, []);

		const clearStatusStrip = useCallback((id: string) => {
			statusStripRef.current = statusStripRef.current?.id === id ? null : statusStripRef.current;
			setStatusStrip((current) => (current?.id === id ? null : current));
		}, []);

		const reportError = useCallback((event: CanvasErrorEvent) => {
			onErrorRef.current?.(event);
		}, []);

		useObservableEvent<CanvasToolCallProperties>(
			useCallback(
				(event) => {
					if (!isCanvasToolCallMessage(event)) return;

					try {
						if (event.canvas_config === undefined || event.canvas_config === null) {
							const controlCommand = parseCanvasControlCommand(event);
							if (!controlCommand) return;

							const routed = applyTaskStatusCommand(statusStripRef.current, controlCommand);
							if (routed.consumed) {
								statusStripRef.current = routed.strip;
								setStatusStrip(routed.strip);
								return;
							}

							setInstances((current) => applyCanvasCommand(current, controlCommand));
							return;
						}

						const canvasConfig = parseCanvasConfig(event.canvas_config);
						if (!canvasConfig) {
							reportError({
								code: 'malformed_canvas_config',
								message: 'Received malformed Magic Canvas config.',
								conversation_id: event.conversation_id,
								tool_call_id: event.properties.tool_call_id,
							});
							return;
						}

						const toolCallId = event.properties.tool_call_id;
						if (!toolCallId) {
							reportError({
								code: 'missing_tool_call_id',
								message: 'Received Magic Canvas tool call without tool_call_id.',
								conversation_id: event.conversation_id,
								component: canvasConfig.component,
							});
							return;
						}

						const parsedArguments = parseToolArguments(event.properties.arguments);
						if (!parsedArguments.ok) {
							reportError({
								code: 'invalid_tool_arguments',
								message: parsedArguments.error.message,
								conversation_id: event.conversation_id,
								tool_call_id: toolCallId,
								component: canvasConfig.component,
								cause: parsedArguments.error,
							});
							return;
						}

						const instance = createCanvasInstance({
							conversationId: event.conversation_id,
							toolCallId,
							args: parsedArguments.value,
							canvasConfig,
						});

						const showCommand = { kind: 'show' as const, instance };
						const routed = applyTaskStatusCommand(statusStripRef.current, showCommand);
						if (routed.consumed) {
							statusStripRef.current = routed.strip;
							setStatusStrip(routed.strip);
							return;
						}

						setInstances((current) => applyCanvasCommand(current, showCommand));
					} catch (error) {
						reportError({
							code: 'invalid_tool_arguments',
							message: error instanceof Error ? error.message : String(error),
							conversation_id: event.conversation_id,
							tool_call_id: event.properties.tool_call_id,
						});
					}
				},
				[reportError]
			)
		);

		const resolvedInstances = instances.map((instance) => ({
			instance,
			layout: resolveCanvasLayout(instance, viewport),
		}));
		const sidecarLayout = resolveCanvasSidecarLayout(
			resolvedInstances.map(({ layout }) => layout),
			viewport
		);
		const fullscreenToolCallId = [...resolvedInstances]
			.reverse()
			.find(({ layout }) => layout.display_mode === 'fullscreen')?.instance.tool_call_id;

		useEffect(() => {
			onLayoutEffectChange?.(sidecarLayout);
		}, [
			onLayoutEffectChange,
			sidecarLayout.active,
			sidecarLayout.side,
			sidecarLayout.video_shift_x,
			sidecarLayout.backdrop.type,
			sidecarLayout.safe_area?.x,
			sidecarLayout.safe_area?.y,
			sidecarLayout.safe_area?.width,
			sidecarLayout.safe_area?.height,
		]);

		if (instances.length === 0 && !statusStrip) return null;

		const controlsBoxHeight = visualViewportFrame?.height ?? viewport.height;
		const controlsTopPx = callControlsRect
			? Math.max(0, controlsBoxHeight - callControlsRect.y)
			: 0;
		const stripLayout: CanvasResolvedLayout | null = statusStrip
			? {
					...statusStrip.layout,
					preferred_slot: 'safe-area-bottom',
					display_mode: 'inline',
					viable_slot: 'safe-area-bottom',
				}
			: null;
		const stripRenderer = statusStrip ? resolveCanvasRenderer(renderComponent, statusStrip) : null;

		return (
			<div
				className={[styles.container, className].filter(Boolean).join(' ')}
				// `bottom: auto` is required: the class sets inset:0, and top+height+bottom
				// together over-constrain the box.
				style={
					visualViewportFrame
						? {
								top: `${visualViewportFrame.top}px`,
								height: `${visualViewportFrame.height}px`,
								bottom: 'auto',
							}
						: undefined
				}
			>
				{fullscreenToolCallId && <div className={styles.backdrop} />}
				{CANVAS_LAYOUT_SLOTS.map((slot) => {
					const slotInstances = resolvedInstances.filter(
						({ layout }) => canvasRenderSlot(layout) === slot
					);
					if (slotInstances.length === 0) return null;

					return (
						<CanvasSlot key={slot} slot={slot}>
							{(availableHeight) =>
								slotInstances.map(({ instance, layout }) => {
									const dimmed = Boolean(
										fullscreenToolCallId && fullscreenToolCallId !== instance.tool_call_id
									);
									const onComplete = () => {
										setInstances((current) => current.filter((item) => item.id !== instance.id));
									};

									// Default-off: native renderer only when the registry has an entry
									// for this component@version; otherwise the iframe path, unchanged.
									const renderer = resolveCanvasRenderer(renderComponent, instance);
									if (renderer) {
										return (
											<NativeCanvasHost
												key={instance.id}
												instance={instance}
												layout={layout}
												render={renderer}
												dimmed={dimmed}
												onComplete={onComplete}
												onError={onError}
												onInteraction={onInteraction}
											/>
										);
									}

									return (
										<CanvasFrame
											key={instance.id}
											availableHeight={availableHeight}
											instance={instance}
											layout={layout}
											dimmed={dimmed}
											isInstanceLive={isInstanceLive}
											onComplete={onComplete}
											onDisplayModeChange={(displayMode) => {
												setInstances((current) =>
													current.map((item) =>
														item.tool_call_id === instance.tool_call_id
															? { ...item, layout: { ...item.layout, display_mode: displayMode } }
															: item
													)
												);
											}}
											onError={onError}
											onInteraction={onInteraction}
										/>
									);
								})
							}
						</CanvasSlot>
					);
				})}
				{statusStrip && stripLayout && (
					<div
						className={styles.statusStrip}
						style={statusStripPlacement(
							callControlsRect
								? { x: callControlsRect.x, width: callControlsRect.width }
								: undefined,
							controlsTopPx,
							viewport.width
						)}
						data-canvas-status-strip
					>
						<div
							className={styles.statusStripInner}
							style={
								callControlsRect
									? undefined
									: { maxWidth: `${STATUS_STRIP_FALLBACK_MAX_WIDTH_PX}px` }
							}
						>
							{stripRenderer ? (
								<NativeCanvasHost
									key={statusStrip.id}
									instance={statusStrip}
									layout={stripLayout}
									render={stripRenderer}
									onComplete={() => clearStatusStrip(statusStrip.id)}
									onError={onError}
									onInteraction={onInteraction}
									variant="strip"
								/>
							) : (
								<CanvasFrame
									key={statusStrip.id}
									availableHeight={STATUS_STRIP_MAX_HEIGHT_PX}
									instance={statusStrip}
									layout={stripLayout}
									isInstanceLive={isStripInstanceLive}
									onComplete={() => clearStatusStrip(statusStrip.id)}
									onError={onError}
									onInteraction={onInteraction}
									variant="strip"
								/>
							)}
						</div>
					</div>
				)}
			</div>
		);
	}
);

MagicCanvas.displayName = 'MagicCanvas';

type CanvasFrameProps = {
	availableHeight?: number;
	instance: CanvasInstance;
	layout: CanvasResolvedLayout;
	dimmed?: boolean;
	/** Whether the parent still holds this instance; absent means "assume gone". */
	isInstanceLive?: (id: string) => boolean;
	onComplete?: () => void;
	onDisplayModeChange?: (displayMode: CanvasDisplayMode) => void;
	onInteraction?: (event: CanvasInteractionEvent) => void | Promise<void>;
	onError?: (event: CanvasErrorEvent) => void;
	variant?: 'card' | 'strip';
};

const CanvasFrame = memo(
	({
		availableHeight,
		instance,
		layout,
		dimmed,
		isInstanceLive,
		onComplete,
		onDisplayModeChange,
		onInteraction,
		onError,
		variant = 'card',
	}: CanvasFrameProps) => {
		const isStrip = variant === 'strip';
		const maxFrameHeight = isStrip ? STATUS_STRIP_MAX_HEIGHT_PX : MAGIC_CANVAS_MAX_HEIGHT_PX;
		const iframeRef = useRef<HTMLIFrameElement>(null);
		const bridgeRef = useRef<AppBridge | null>(null);
		const availableHeightRef = useRef(availableHeight);
		const instanceRef = useRef(instance);
		const layoutRef = useRef(layout);
		const lastSentRevisionRef = useRef(-1);
		const sendAppMessage = useSendAppMessage();
		const onCompleteRef = useRef(onComplete);
		const onDisplayModeChangeRef = useRef(onDisplayModeChange);
		const onInteractionRef = useRef(onInteraction);
		const onErrorRef = useRef(onError);
		const sendAppMessageRef = useRef(sendAppMessage);
		const isInstanceLiveRef = useRef(isInstanceLive);
		// Cold default is the tallest card so a late/lost size report scales into view instead of clipping.
		const [frameHeight, setFrameHeight] = useState(
			isStrip ? STATUS_STRIP_DEFAULT_HEIGHT_PX : MAGIC_CANVAS_MAX_HEIGHT_PX
		);
		const [ready, setReady] = useState(false);
		// The handshake resolving is not enough to paint: the cold frame height is
		// still the tallest card until the app reports its own.
		const [sized, setSized] = useState(false);

		useEffect(() => {
			instanceRef.current = instance;
		}, [instance]);

		useEffect(() => {
			layoutRef.current = layout;
			bridgeRef.current?.setHostContext(
				buildFrameHostContext(instanceRef.current, layout, availableHeightRef.current)
			);
		}, [layout]);

		// Height lives in its own effect so a slot resize only resends the host
		// context; it must never re-run the connect effect below, which tears the
		// bridge down and reloads the iframe.
		useEffect(() => {
			availableHeightRef.current = availableHeight;

			const timer = setTimeout(() => {
				bridgeRef.current?.setHostContext(
					buildFrameHostContext(instanceRef.current, layoutRef.current, availableHeight)
				);
			}, AVAILABLE_HEIGHT_COALESCE_MS);

			return () => clearTimeout(timer);
		}, [availableHeight]);

		useEffect(() => {
			onCompleteRef.current = onComplete;
			onDisplayModeChangeRef.current = onDisplayModeChange;
			onInteractionRef.current = onInteraction;
			onErrorRef.current = onError;
			sendAppMessageRef.current = sendAppMessage;
			isInstanceLiveRef.current = isInstanceLive;
		}, [onComplete, onDisplayModeChange, onInteraction, onError, sendAppMessage, isInstanceLive]);

		useEffect(() => {
			const iframe = iframeRef.current;
			if (!iframe) return;

			let closed = false;
			let bridge: AppBridge | null = null;
			let pendingModelContextUpdate: CanvasModelContextUpdate | null = null;
			let modelContextRelayTimer: ReturnType<typeof setTimeout> | null = null;
			// `closed` is also true when the card merely changed slots and the frame
			// was rebuilt around a live interaction, so dropping the user's answer
			// takes the card being gone too.
			const tornDown = () => closed && !isInstanceLiveRef.current?.(instanceRef.current.id);
			// Decision 17 deferred-submit completion, shared with NativeCanvasHost.
			const completionScheduler = createCanvasCompletionScheduler(tornDown);
			const targetHref = new URL(instance.canvas_config.sandbox_url, globalThis.location?.href)
				.href;

			const reportError = (event: CanvasErrorEvent) => {
				if (!closed) onErrorRef.current?.(event);
			};

			// Delivery failures can finish after this frame closes (background
			// retries outlive the card on purpose) and must still reach the
			// consumer error channel, so this one is not gated on `closed`.
			const reportDeliveryError = (event: CanvasErrorEvent) => {
				onErrorRef.current?.(event);
			};

			const flushModelContextUpdate = () => {
				if (closed || !pendingModelContextUpdate) return;

				const currentInstance = instanceRef.current;
				sendAppMessageRef.current({
					message_type: 'conversation',
					event_type: 'conversation.append_llm_context',
					conversation_id: currentInstance.conversation_id,
					properties: {
						context: buildCanvasModelContextAppend(currentInstance, pendingModelContextUpdate),
					},
				});
				pendingModelContextUpdate = null;
			};

			const buildFrameError = (
				code: CanvasErrorCode,
				defaultMessage: string,
				cause: unknown
			): CanvasErrorEvent => ({
				code,
				message: cause instanceof Error && cause.message ? cause.message : defaultMessage,
				conversation_id: instance.conversation_id,
				tool_call_id: instance.tool_call_id,
				component: instance.canvas_config.component,
				cause,
			});

			const connectBridge = () => {
				if (bridge || iframe.src !== targetHref) return;
				if (closed || !iframe.contentWindow) return;

				const nextBridge = new AppBridge(
					null,
					{ name: '@tavus/cvi-ui', version: '0.0.0' },
					{
						logging: {},
						message: {
							text: {},
							structuredContent: {},
						},
						updateModelContext: {
							text: {},
							structuredContent: {},
						},
					},
					{
						hostContext: buildFrameHostContext(
							instance,
							layoutRef.current,
							availableHeightRef.current
						),
					}
				);
				bridge = nextBridge;
				bridgeRef.current = nextBridge;

				nextBridge.oninitialized = () => {
					if (closed) return;
					setReady(true);
					lastSentRevisionRef.current = instanceRef.current.revision;
					void nextBridge
						.sendToolInput({ arguments: instanceRef.current.arguments })
						.catch((error) => {
							reportError(
								buildFrameError(
									'send_tool_input_failed',
									'Magic Canvas failed to send tool input to the iframe.',
									error
								)
							);
						});
				};

				nextBridge.onsizechange = ({ height }) => {
					if (!closed && typeof height === 'number' && Number.isFinite(height)) {
						setFrameHeight(
							Math.min(Math.max(height, CANVAS_REPORTED_HEIGHT_FLOOR_PX), maxFrameHeight)
						);
						setSized(true);
					}
				};

				nextBridge.onmessage = async (message) => {
					let interaction: CanvasInteractionEvent | null = null;
					const interactionPayload = extractCanvasInteraction(message);

					if (interactionPayload) {
						try {
							interaction = normalizeInteraction(instanceRef.current, interactionPayload);
						} catch (error) {
							reportError(
								buildFrameError(
									'interaction_normalization_failed',
									'Magic Canvas failed to normalize an interaction.',
									error
								)
							);
						}
					}

					if (!interaction) {
						if (hasTextContent(message)) {
							reportError({
								code: 'missing_interaction_metadata',
								message:
									'Magic Canvas message included text without interaction metadata; no interaction row was recorded.',
								conversation_id: instance.conversation_id,
								tool_call_id: instance.tool_call_id,
								component: instance.canvas_config.component,
							});
						}
						return {};
					}

					let responseText = '';
					try {
						responseText = extractTextContent(message, interaction);
					} catch (error) {
						reportError(
							buildFrameError(
								'interaction_normalization_failed',
								'Magic Canvas dropped response text the interaction does not allow.',
								error
							)
						);
					}

					// Best-effort delivery (PROD-5180): a failed POST no longer
					// blocks respond/complete. The click must still reach the
					// persona over the Daily channel even when the browser cannot
					// reach the interaction endpoint; the POST retries in the
					// background and reports through onError on final failure.
					await deliverCanvasInteraction({
						interaction,
						canvasConfig: instance.canvas_config,
						onInteraction: onInteractionRef.current,
						reportError,
						reportDeliveryError,
						buildError: buildFrameError,
					});

					// A teardown can race the awaited delivery: never respond into
					// the call or complete on behalf of a card the host dropped.
					if (tornDown()) return {};

					if (responseText) {
						sendAppMessageRef.current({
							message_type: 'conversation',
							event_type: 'conversation.respond',
							conversation_id: instance.conversation_id,
							properties: {
								text: responseText,
							},
						});
					}

					// Submit defers so the embedded app's confirmation
					// (or the full quiz reveal) stays visible;
					// skip/dismiss/clear complete instantly.
					completionScheduler.complete(
						interaction,
						() => onCompleteRef.current?.(),
						canvasSubmitTeardownDelayMs(instance.arguments)
					);

					return {};
				};

				nextBridge.onupdatemodelcontext = async (modelContextUpdate) => {
					pendingModelContextUpdate = modelContextUpdate;
					if (!modelContextRelayTimer) {
						modelContextRelayTimer = setTimeout(() => {
							modelContextRelayTimer = null;
							flushModelContextUpdate();
						}, MODEL_CONTEXT_RELAY_INTERVAL_MS);
					}

					return {};
				};

				nextBridge.onrequestdisplaymode = async ({ mode }) => {
					if (isStrip) return { mode: 'inline' };
					const nextMode = mode === 'fullscreen' ? 'fullscreen' : 'inline';
					onDisplayModeChangeRef.current?.(nextMode);
					layoutRef.current = {
						...layoutRef.current,
						display_mode: nextMode,
						viable_slot: nextMode === 'fullscreen' ? 'full' : layoutRef.current.viable_slot,
					};
					nextBridge.setHostContext(
						buildFrameHostContext(
							instanceRef.current,
							layoutRef.current,
							availableHeightRef.current
						)
					);
					return { mode: nextMode };
				};

				// See the CanvasFrameTransport class comment for why the SDK's
				// PostMessageTransport can't be used for this pre-navigation connect.
				void nextBridge.connect(new CanvasFrameTransport(iframe)).catch((error) => {
					reportError(
						buildFrameError(
							'bridge_connect_failed',
							'Magic Canvas iframe bridge failed to connect.',
							error
						)
					);
				});
			};

			const disconnectFrame = wireCanvasFrameConnect(iframe, targetHref, connectBridge);

			return () => {
				if (modelContextRelayTimer) {
					clearTimeout(modelContextRelayTimer);
					modelContextRelayTimer = null;
				}
				flushModelContextUpdate();
				closed = true;
				completionScheduler.cancel();
				disconnectFrame();
				bridgeRef.current = null;
				if (bridge) void closeBridge(bridge);
			};
		}, [instance.id, instance.canvas_config.sandbox_url, isStrip, maxFrameHeight]);

		useEffect(() => {
			if (!ready || instance.revision === 0) return;
			if (instance.revision <= lastSentRevisionRef.current) return;
			lastSentRevisionRef.current = instance.revision;
			void bridgeRef.current?.sendToolInput({ arguments: instance.arguments }).catch((error) => {
				onErrorRef.current?.({
					code: 'send_tool_input_failed',
					message: error instanceof Error ? error.message : String(error),
					conversation_id: instance.conversation_id,
					tool_call_id: instance.tool_call_id,
					component: instance.canvas_config.component,
					cause: error,
				});
			});
		}, [instance, ready]);

		const isFull = layout.viable_slot === 'full' || layout.display_mode === 'fullscreen';
		const inlineFit = isFull ? null : resolveInlineFrameFit(frameHeight, availableHeight);
		const placeholderStyle = inlineFit?.placeholderStyle;
		const cardStyle = inlineFit?.cardStyle;
		const iframeStyle: React.CSSProperties = isFull
			? { height: '100%' }
			: (inlineFit?.iframeStyle ?? { height: frameHeight });

		const shellClassName = isStrip
			? styles.stripShell
			: [
					styles.frameShell,
					ready && sized ? styles.frameShellReady : '',
					isFull ? styles.frameShellFull : '',
					dimmed ? styles.frameShellDimmed : '',
				]
					.filter(Boolean)
					.join(' ');
		const isInert = isStrip ? !ready : !(ready && sized);

		const card = (
			<div
				className={shellClassName}
				style={cardStyle}
				data-canvas-card={isStrip ? undefined : layout.viable_slot}
				data-canvas-strip={isStrip ? layout.viable_slot : undefined}
				// Spread, not inert={bool}: the attribute must be ABSENT when ready —
				// React 18 renders inert={false} as an ACTIVE inert="false".
				{...(isInert ? { inert: true } : {})}
			>
				<iframe
					ref={iframeRef}
					title={`${instance.canvas_config.component} ${instance.canvas_config.component_version}`}
					className={styles.frame}
					sandbox={
						COMPONENT_IFRAME_SANDBOX[instance.canvas_config.component] ?? DEFAULT_IFRAME_SANDBOX
					}
					style={iframeStyle}
				/>
			</div>
		);

		// Full-screen cards own the viewport; otherwise wrap in a placeholder that
		// reserves the (possibly scaled) layout height so a scaled card does not
		// overlap siblings. Mirrors the tavus-deployment host.
		if (isFull || isStrip) return card;

		return (
			<div className={styles.framePlaceholder} style={placeholderStyle}>
				{card}
			</div>
		);
	}
);

CanvasFrame.displayName = 'CanvasFrame';

type CanvasSlotProps = {
	slot: CanvasLayoutSlot;
	children: (availableHeight?: number) => React.ReactNode;
};

// Wraps a layout slot, measuring its available height so the frame inside can
// scale-to-fit (and fall back to scroll) when the content is taller than the
// band. Side slots scroll (overflow-y) and center their card with an inner
// `my-auto`-style stack that collapses when the content overflows, so a too-tall
// card scrolls from the top instead of being clipped by the slot.
function hasTextContent(message: { content: Array<Record<string, unknown>> }) {
	return message.content.some(
		(block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== ''
	);
}

function CanvasSlot({ slot, children }: CanvasSlotProps) {
	const [ref, availableHeight] = useCanvasSlotHeight();
	const content = children(slot === 'full' ? undefined : availableHeight);
	const stackClassName = innerStackClassName(slot);

	return (
		<div ref={ref} className={`${styles.slot} ${slotClassName(slot)}`} data-canvas-slot={slot}>
			{stackClassName ? <div className={stackClassName}>{content}</div> : content}
		</div>
	);
}

function useCanvasSlotHeight() {
	const ref = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState<number>();

	useEffect(() => {
		const element = ref.current;
		if (!element) return;

		const setMeasuredHeight = (nextHeight?: number) => {
			const measuredHeight = nextHeight ?? element.getBoundingClientRect().height;
			if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return;
			setHeight(Math.floor(measuredHeight));
		};
		const updateFromLayout = () => setMeasuredHeight();

		updateFromLayout();

		if (typeof ResizeObserver === 'undefined') {
			globalThis.addEventListener('resize', updateFromLayout);
			return () => globalThis.removeEventListener('resize', updateFromLayout);
		}

		const observer = new ResizeObserver((entries) => {
			setMeasuredHeight(entries[0]?.contentRect.height);
		});
		observer.observe(element);

		return () => observer.disconnect();
	}, []);

	return [ref, height] as const;
}

// Advertise the slot's measured height so the app can size itself to the band
// (and scroll its own content) instead of reporting a taller natural height that
// the host then has to scale down. `containerDimensions.maxHeight` is the only
// channel for it: the app SDK's host-context schema drops maxHeight when a
// sibling `height` key is present and always strips displayScale. Mirrors
// buildFrameHostContext in the tavus-deployment host.
export function buildFrameHostContext(
	instance: CanvasInstance,
	layout: CanvasResolvedLayout,
	availableHeight?: number
): JsonRecord {
	const context = buildHostContext(instance, layout);
	const isFull = layout.viable_slot === 'full' || layout.display_mode === 'fullscreen';
	if (isFull) return context;

	return {
		...context,
		containerDimensions: {
			...(isRecord(context.containerDimensions) ? context.containerDimensions : {}),
			maxHeight: maxInlineFrameHeight(availableHeight),
		},
	};
}

function maxInlineFrameHeight(availableHeight?: number) {
	if (availableHeight === undefined || !Number.isFinite(availableHeight) || availableHeight <= 0) {
		return MAGIC_CANVAS_MAX_HEIGHT_PX;
	}

	return Math.min(Math.floor(availableHeight), MAGIC_CANVAS_MAX_HEIGHT_PX);
}

// Floor for scale-to-fit. PROD-3708 removed it because a clamped card's Submit
// footer ended up outside the slot's hittable box; the slots now scroll, so a
// floored card is reachable and shrinking past readability is the worse failure.
const MIN_CANVAS_DISPLAY_SCALE = 0.85;

// Iframe width MUST stay 100% in every branch; a per-scale viewport can trigger a width-breakpoint feedback loop.
export function resolveInlineFrameFit(naturalHeight: number, availableHeight?: number) {
	if (availableHeight === undefined || !Number.isFinite(availableHeight) || availableHeight <= 0) {
		return null;
	}

	const clampedNatural = Math.min(naturalHeight, MAGIC_CANVAS_MAX_HEIGHT_PX);

	if (clampedNatural <= availableHeight) {
		return {
			displayScale: 1,
			placeholderStyle: { maxHeight: `${availableHeight}px` } as React.CSSProperties,
			cardStyle: undefined as React.CSSProperties | undefined,
			iframeStyle: { width: '100%', height: `${clampedNatural}px` } as React.CSSProperties,
		};
	}

	const ratio = Math.max(availableHeight / clampedNatural, MIN_CANVAS_DISPLAY_SCALE);
	const scaledHeight = clampedNatural * ratio;

	return {
		displayScale: ratio,
		// No maxHeight/overflow clamp: when the floor engages the card is taller
		// than the band on purpose, and the slot scrolls it. Below the floor these
		// were redundant anyway (scaledHeight === availableHeight exactly).
		placeholderStyle: {
			height: `${scaledHeight}px`,
		} as React.CSSProperties,
		cardStyle: {
			height: `${clampedNatural}px`,
			transform: `scale(${ratio})`,
			transformOrigin: 'top center',
		} as React.CSSProperties,
		iframeStyle: { width: '100%', height: `${clampedNatural}px` } as React.CSSProperties,
	};
}

function useCanvasViewport(): CanvasViewport {
	const [viewport, setViewport] = useState<CanvasViewport>(() => readCanvasViewport());

	useEffect(() => {
		const updateViewport = () => setViewport(readCanvasViewport());

		window.addEventListener('resize', updateViewport);
		window.visualViewport?.addEventListener('resize', updateViewport);

		return () => {
			window.removeEventListener('resize', updateViewport);
			window.visualViewport?.removeEventListener('resize', updateViewport);
		};
	}, []);

	return viewport;
}

// The canvas layer is position:fixed, which on iOS is laid out against the
// LAYOUT viewport. Opening the keyboard leaves that viewport alone and instead
// shrinks and scrolls the VISUAL viewport, so a bottom-anchored card is pushed
// out of the visible band — it reads as the card jumping to the top of the
// screen. Track the visual viewport (scroll as well as resize; resize alone
// misses the offset) and pin the layer to it. Returns null where the API is
// absent, so those browsers keep the plain inset:0 layer.
function useVisualViewportFrame(): { top: number; height: number } | null {
	const [frame, setFrame] = useState(() => readVisualViewportFrame());

	useEffect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;

		const update = () => setFrame(readVisualViewportFrame());

		update();
		viewport.addEventListener('resize', update);
		viewport.addEventListener('scroll', update);

		return () => {
			viewport.removeEventListener('resize', update);
			viewport.removeEventListener('scroll', update);
		};
	}, []);

	return frame;
}

function readVisualViewportFrame() {
	const viewport = window.visualViewport;
	if (!viewport) return null;

	return { top: viewport.offsetTop, height: viewport.height };
}

function readCanvasViewport(): CanvasViewport {
	return {
		width: window.innerWidth || 1024,
		height: window.innerHeight || 768,
		visualViewportHeight: window.visualViewport?.height,
	};
}

// Slots whose card is anchored (centered on the sides, bottom in the bottom slot)
// need that anchoring on an inner stack rather than the slot's own
// justify-content, so content taller than the band scrolls from the top.
function innerStackClassName(slot: CanvasLayoutSlot) {
	switch (slot) {
		case 'safe-area-left':
		case 'safe-area-right':
			return styles.sideStack;
		case 'safe-area-bottom':
			return styles.bottomStack;
		default:
			return '';
	}
}

function slotClassName(slot: CanvasLayoutSlot) {
	switch (slot) {
		case 'safe-area-left':
			return styles.slotLeft;
		case 'safe-area-right':
			return styles.slotRight;
		case 'safe-area-bottom':
			return styles.slotBottom;
		case 'full':
			return styles.slotFull;
	}
}

function canvasRenderSlot(layout: CanvasResolvedLayout) {
	if (layout.display_mode === 'fullscreen' && layout.preferred_slot !== 'full') {
		return layout.preferred_slot;
	}

	return layout.viable_slot;
}
