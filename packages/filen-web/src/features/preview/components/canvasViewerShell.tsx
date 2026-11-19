import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import type { DriveItem } from "@/features/drive/lib/item"
import {
	RESTORE_TIMEOUT_MS,
	backingSize,
	coalesceInput,
	keepsKeyFromPager,
	nextDisplay,
	sameBackingSize,
	type BackingSize,
	type CanvasInput,
	type DisplayEvent,
	type DisplayState,
	type ShellToWorker,
	type WorkerToShell
} from "@/features/preview/components/canvasViewerShell.logic"

export interface CanvasViewerShellProps<Status, Notice> {
	// The file shown, named on the card offered when the display is lost.
	readonly item: DriveItem
	// The worker session the canvas belongs to (an owned worker's generation): a new value mints a fresh canvas and port.
	readonly session: number
	// Hands the shell's end of the channel to the worker; the shell posts the canvas over it.
	readonly connect: (port: MessagePort) => void
	// The canvas's accessible name.
	readonly label: string
	readonly onStatus?: (status: Status) => void
	readonly onNotice?: (notice: Notice) => void
	// Restarts the worker after the display could not be restored (it re-reads the file).
	readonly onReload: () => void
	readonly toolbar?: ReactNode
	readonly notice?: ReactNode
	readonly sidePanel?: ReactNode
}

function post(port: MessagePort, message: ShellToWorker, transfer: Transferable[] = []): void {
	port.postMessage(message, transfer)
}

// Mints a canvas into `host` and hands its control over: transferControlToOffscreen works once per element.
function mintCanvas(
	host: HTMLElement,
	label: string,
	previous: HTMLCanvasElement | null
): { element: HTMLCanvasElement; offscreen: OffscreenCanvas } {
	const element = document.createElement("canvas")

	element.className = "block size-full touch-none outline-none"
	element.tabIndex = 0
	element.setAttribute("aria-label", label)

	if (previous !== null) {
		previous.replaceWith(element)
	} else {
		host.append(element)
	}

	return { element, offscreen: element.transferControlToOffscreen() }
}

// The host of a viewer whose worker renders into an OffscreenCanvas (3D, DXF, DICOM, geo): sizing, input, display
// resets and the toolbar, notice and side-panel slots.
export function CanvasViewerShell<Status = never, Notice = never>({
	item,
	session,
	connect,
	label,
	onStatus,
	onNotice,
	onReload,
	toolbar,
	notice,
	sidePanel
}: CanvasViewerShellProps<Status, Notice>) {
	const { t } = useTranslation("preview")
	const hostRef = useRef<HTMLDivElement>(null)
	const [display, setDisplay] = useState<{ session: number; state: DisplayState } | null>(null)
	const state = display?.session === session ? display.state : "live"
	const connectWorker = useEffectEvent(connect)
	const status = useEffectEvent((value: Status) => {
		onStatus?.(value)
	})
	const noticed = useEffectEvent((value: Notice) => {
		onNotice?.(value)
	})
	const canvasLabel = useEffectEvent(() => label)

	useEffect(() => {
		const host = hostRef.current

		if (host === null) {
			return
		}

		const channel = new MessageChannel()
		const port = channel.port1
		const queue: CanvasInput[] = []
		let maxTextureSize: number | null = null
		let size: BackingSize | null = null
		let current: DisplayState = "live"
		let frame: number | null = null
		let resizePending = false
		let timer: ReturnType<typeof setTimeout> | undefined
		let canvas = mintCanvas(host, canvasLabel(), null)

		const measure = (): BackingSize => {
			const rect = host.getBoundingClientRect()

			return backingSize(rect.width, rect.height, window.devicePixelRatio, maxTextureSize)
		}

		const flush = () => {
			frame = null

			if (resizePending) {
				resizePending = false

				const next = measure()

				if (!sameBackingSize(size, next)) {
					size = next
					post(port, { type: "resize", ...next })
				}
			}

			if (queue.length > 0) {
				post(port, { type: "input", events: queue.splice(0) })
			}
		}

		const schedule = () => {
			frame ??= requestAnimationFrame(flush)
		}

		const sendCanvas = () => {
			size = measure()
			post(port, { type: "canvas", canvas: canvas.offscreen, hidden: document.hidden, ...size }, [canvas.offscreen])
		}

		const move = (event: DisplayEvent) => {
			const next = nextDisplay(current, event)

			if (next === current) {
				return
			}

			clearTimeout(timer)
			timer = undefined
			current = next
			setDisplay({ session, state: next })

			if (next === "restoring" || next === "replacing") {
				timer = setTimeout(() => {
					move("timeout")
				}, RESTORE_TIMEOUT_MS)
			}

			if (next === "replacing") {
				// A context that did not come back: the same worker builds a new renderer on a fresh canvas.
				canvas = mintCanvas(host, canvasLabel(), canvas.element)
				bind(canvas.element)
				sendCanvas()
			}
		}

		port.onmessage = ({ data }: MessageEvent<WorkerToShell<Status, Notice>>) => {
			switch (data.type) {
				case "limits": {
					maxTextureSize = data.maxTextureSize
					resizePending = true
					schedule()

					break
				}

				case "contextLost": {
					move("lost")

					break
				}

				case "contextRestored": {
					move("restored")

					break
				}

				case "contextFailed": {
					move("failed")

					break
				}

				case "status": {
					status(data.status)

					break
				}

				case "notice": {
					noticed(data.notice)

					break
				}
			}
		}

		const position = (event: MouseEvent) => {
			const rect = host.getBoundingClientRect()
			const scale = size?.pixelRatio ?? 1

			return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale }
		}

		const queueInput = (input: CanvasInput) => {
			coalesceInput(queue, input)
			schedule()
		}

		const pointer = (phase: "down" | "move" | "up" | "cancel") => (event: PointerEvent) => {
			if (phase === "down") {
				canvas.element.focus()
				canvas.element.setPointerCapture(event.pointerId)
			}

			queueInput({
				type: "pointer",
				phase,
				id: event.pointerId,
				pointerType: event.pointerType,
				buttons: event.buttons,
				...position(event)
			})
		}

		const wheel = (event: WheelEvent) => {
			event.preventDefault()

			// Lines and pages as the usual pixel steps.
			const unit =
				event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? host.clientHeight : 1

			queueInput({
				type: "wheel",
				deltaX: event.deltaX * unit,
				deltaY: event.deltaY * unit,
				ctrlKey: event.ctrlKey,
				...position(event)
			})
		}

		const key = (phase: "down" | "up") => (event: KeyboardEvent) => {
			if (keepsKeyFromPager(event.key)) {
				event.stopPropagation()
				event.preventDefault()
			}

			queueInput({
				type: "key",
				phase,
				key: event.key,
				code: event.code,
				shiftKey: event.shiftKey,
				ctrlKey: event.ctrlKey,
				altKey: event.altKey,
				metaKey: event.metaKey
			})
		}

		const listeners = [
			["pointerdown", pointer("down")],
			["pointermove", pointer("move")],
			["pointerup", pointer("up")],
			["pointercancel", pointer("cancel")],
			["keydown", key("down")],
			["keyup", key("up")]
		] as const

		function bind(element: HTMLCanvasElement): void {
			for (const [type, listener] of listeners) {
				element.addEventListener(type, listener as EventListener)
			}

			element.addEventListener("wheel", wheel, { passive: false })
		}

		const visibility = () => {
			post(port, { type: "visibility", hidden: document.hidden })
		}

		const observer = new ResizeObserver(() => {
			resizePending = true
			schedule()
		})

		bind(canvas.element)
		observer.observe(host)
		document.addEventListener("visibilitychange", visibility)
		connectWorker(channel.port2)
		sendCanvas()

		return () => {
			clearTimeout(timer)

			if (frame !== null) {
				cancelAnimationFrame(frame)
			}

			observer.disconnect()
			document.removeEventListener("visibilitychange", visibility)
			port.onmessage = null
			port.close()
			canvas.element.remove()
		}
	}, [session])

	return (
		<div className="flex size-full min-h-0 max-sm:flex-col">
			<div className="@container relative min-h-0 min-w-0 flex-1">
				<div
					ref={hostRef}
					className="absolute inset-0"
				/>
				{state === "restoring" || state === "replacing" ? (
					<div
						aria-live="polite"
						className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/70 text-sm"
					>
						<PreviewLoading />
						{t("previewRichShellRestoring")}
					</div>
				) : null}
				{state === "failed" ? (
					<div className="absolute inset-0 bg-background">
						<PreviewUnsupportedState
							item={item}
							message={t("previewRichShellContextFailed")}
							secondary={
								<Button
									variant="outline"
									onClick={onReload}
								>
									{t("previewRichShellReload")}
								</Button>
							}
						/>
					</div>
				) : null}
				{state !== "failed" && notice !== undefined ? (
					<div className="pointer-events-none absolute bottom-16 left-3 text-sm">{notice}</div>
				) : null}
				{state !== "failed" && toolbar !== undefined ? (
					<div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
						<div className="pointer-events-auto">{toolbar}</div>
					</div>
				) : null}
			</div>
			{sidePanel !== undefined ? (
				<aside className="w-72 shrink-0 overflow-y-auto border-s max-sm:max-h-[45%] max-sm:w-full max-sm:border-s-0 max-sm:border-t">
					{sidePanel}
				</aside>
			) : null}
		</div>
	)
}
