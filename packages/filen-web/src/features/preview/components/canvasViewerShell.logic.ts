// The canvas viewer shell's protocol with its worker and its pure parts: the backing-store size, the per-frame input
// coalescing and the display-reset state. Workers import the protocol types; nothing here touches the DOM.

// Above 2 a canvas only costs memory and fill rate.
export const MAX_PIXEL_RATIO = 2
export const MAX_BACKING_SIDE = 4096
// A lost context that has not come back by then gets a fresh canvas.
export const RESTORE_TIMEOUT_MS = 5000

export interface BackingSize {
	readonly width: number
	readonly height: number
	// Backing pixels per CSS pixel, after both caps.
	readonly pixelRatio: number
}

// Both sides scale together, so the aspect survives the cap.
export function backingSize(cssWidth: number, cssHeight: number, devicePixelRatio: number, maxTextureSize: number | null): BackingSize {
	const ratio = Math.min(Math.max(devicePixelRatio, 1), MAX_PIXEL_RATIO)
	const side = Math.min(MAX_BACKING_SIDE, maxTextureSize ?? MAX_BACKING_SIDE)
	const width = Math.max(cssWidth, 0) * ratio
	const height = Math.max(cssHeight, 0) * ratio
	const scale = Math.min(1, side / Math.max(width, 1), side / Math.max(height, 1))

	return {
		width: Math.max(1, Math.floor(width * scale)),
		height: Math.max(1, Math.floor(height * scale)),
		pixelRatio: ratio * scale
	}
}

export function sameBackingSize(a: BackingSize | null, b: BackingSize): boolean {
	return a?.width === b.width && a.height === b.height && a.pixelRatio === b.pixelRatio
}

// Positions are in backing pixels, the space the worker renders in.
export interface CanvasPointerInput {
	readonly type: "pointer"
	readonly phase: "down" | "move" | "up" | "cancel"
	readonly id: number
	readonly pointerType: string
	readonly x: number
	readonly y: number
	readonly buttons: number
}

// Deltas in pixels, summed over the frame.
export interface CanvasWheelInput {
	readonly type: "wheel"
	readonly x: number
	readonly y: number
	readonly deltaX: number
	readonly deltaY: number
	readonly ctrlKey: boolean
}

export interface CanvasKeyInput {
	readonly type: "key"
	readonly phase: "down" | "up"
	readonly key: string
	readonly code: string
	readonly shiftKey: boolean
	readonly ctrlKey: boolean
	readonly altKey: boolean
	readonly metaKey: boolean
}

export type CanvasInput = CanvasPointerInput | CanvasWheelInput | CanvasKeyInput

export type ShellToWorker =
	// The first canvas of a session, and a fresh one after a context that did not come back: the worker builds its
	// renderer over the scene it retains.
	| ({ readonly type: "canvas"; readonly canvas: OffscreenCanvas; readonly hidden: boolean } & BackingSize)
	| ({ readonly type: "resize" } & BackingSize)
	| { readonly type: "input"; readonly events: readonly CanvasInput[] }
	// Playback (cine, animation) is suspended while the document is hidden.
	| { readonly type: "visibility"; readonly hidden: boolean }

export type WorkerToShell<Status = never, Notice = never> =
	| { readonly type: "limits"; readonly maxTextureSize: number }
	| { readonly type: "contextLost" }
	| { readonly type: "contextRestored" }
	// No renderer could be built on a fresh canvas.
	| { readonly type: "contextFailed" }
	| { readonly type: "status"; readonly status: Status }
	| { readonly type: "notice"; readonly notice: Notice }

// One message per frame: consecutive moves of a pointer keep the latest, consecutive wheel turns add up. Presses,
// releases and keys are never dropped and keep their order.
export function coalesceInput(queue: CanvasInput[], next: CanvasInput): void {
	const last = queue.at(-1)

	if (next.type === "pointer" && next.phase === "move" && last?.type === "pointer" && last.phase === "move" && last.id === next.id) {
		queue[queue.length - 1] = next

		return
	}

	if (next.type === "wheel" && last?.type === "wheel" && last.ctrlKey === next.ctrlKey) {
		queue[queue.length - 1] = { ...next, deltaX: last.deltaX + next.deltaX, deltaY: last.deltaY + next.deltaY }

		return
	}

	queue.push(next)
}

// live → (lost) restoring → (timeout) replacing, with a fresh canvas → (timeout or contextFailed) failed. A restore at
// any point before failed goes back to live.
export type DisplayState = "live" | "restoring" | "replacing" | "failed"

export type DisplayEvent = "lost" | "restored" | "timeout" | "failed"

export function nextDisplay(state: DisplayState, event: DisplayEvent): DisplayState {
	if (state === "failed") {
		return state
	}

	switch (event) {
		case "lost": {
			return state === "live" ? "restoring" : state
		}

		case "restored": {
			return "live"
		}

		case "timeout": {
			if (state === "restoring") {
				return "replacing"
			}

			return state === "replacing" ? "failed" : state
		}

		case "failed": {
			return "failed"
		}
	}
}

// Arrow keys page between siblings unless an interactive canvas has focus.
export function keepsKeyFromPager(key: string): boolean {
	return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown"
}
