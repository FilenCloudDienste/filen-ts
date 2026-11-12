// Real OS pointer input for chain D (scripts/ci/e2e/chains/dragOut.ts), the pure half: a gesture is planned here as a
// list of primitives (pointer moves at about 60 Hz, the left button, Escape and pauses) and handed to one bounded
// helper per OS (scripts/ci/e2e/dragDesktop.ts): SendInput on Windows, CoreGraphics HID events on macOS, xdotool
// (XTEST) under Xvfb on Linux. Coordinates are the OS's own: physical pixels on Windows and X11, points on macOS.

export interface Point {
	x: number
	y: number
}

export interface Rect {
	x: number
	y: number
	width: number
	height: number
}

// "held": the button is still down from the previous gesture (a drag going on across helper runs); a later move is a
// drag even where the helper cannot read the button's state.
export type Primitive =
	{ op: "move"; at: Point } | { op: "down" } | { op: "held" } | { op: "up" } | { op: "escape" } | { op: "sleep"; ms: number }

// One frame at 60 Hz: what a mouse reports at, and how often the drag loops (OLE, AppKit, X DnD) see motion.
export const FRAME_MS = 16

export interface Gesture {
	// The pointer where it is now.
	readonly point: Point
	at(point: Point): Gesture
	press(): Gesture
	// The button is still held from the previous gesture.
	held(): Gesture
	release(): Gesture
	escape(): Gesture
	wait(ms: number): Gesture
	// Moves to `to` over `ms`, one move a frame.
	glide(to: Point, ms: number): Gesture
	// Stays at the point for `ms`, a 1 px jitter every frame, so a drag loop keeps hearing motion; ends where it began.
	hold(ms: number): Gesture
	primitives(): Primitive[]
}

function whole(point: Point): Point {
	return { x: Math.round(point.x), y: Math.round(point.y) }
}

export function gesture(start: Point): Gesture {
	const list: Primitive[] = []
	let current = whole(start)
	const self: Gesture = {
		get point() {
			return current
		},
		at(point) {
			current = whole(point)
			list.push({ op: "move", at: current })

			return self
		},
		press() {
			list.push({ op: "down" })

			return self
		},
		held() {
			list.push({ op: "held" })

			return self
		},
		release() {
			list.push({ op: "up" })

			return self
		},
		escape() {
			list.push({ op: "escape" })

			return self
		},
		wait(ms) {
			if (ms > 0) {
				list.push({ op: "sleep", ms: Math.round(ms) })
			}

			return self
		},
		glide(to, ms) {
			const from = current
			const steps = Math.max(1, Math.round(ms / FRAME_MS))

			for (let step = 1; step <= steps; step++) {
				const fraction = step / steps

				current = whole({ x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction })
				list.push({ op: "move", at: current })
				list.push({ op: "sleep", ms: FRAME_MS })
			}

			return self
		},
		hold(ms) {
			const base = current
			const frames = Math.max(1, Math.round(ms / FRAME_MS))

			for (let frame = 0; frame < frames; frame++) {
				list.push({ op: "move", at: { x: base.x + (frame % 2 === 0 ? 1 : 0), y: base.y } })
				list.push({ op: "sleep", ms: FRAME_MS })
			}

			list.push({ op: "move", at: base })

			return self
		},
		primitives: () => [...list]
	}

	return self
}

// The step text the Windows and macOS helpers read: "m X Y", "d", "h", "u", "k esc", "s MS", separated by ";".
export function encodeSteps(primitives: readonly Primitive[]): string {
	return primitives
		.map(primitive => {
			switch (primitive.op) {
				case "move":
					return `m ${String(primitive.at.x)} ${String(primitive.at.y)}`
				case "down":
					return "d"
				case "held":
					return "h"
				case "up":
					return "u"
				case "escape":
					return "k esc"
				case "sleep":
					return `s ${String(primitive.ms)}`
			}
		})
		.join(";")
}

// One xdotool command line for the whole gesture (xdotool chains commands; its sleep takes seconds).
export function xdotoolArgs(primitives: readonly Primitive[]): string[] {
	return primitives.flatMap(primitive => {
		switch (primitive.op) {
			case "move":
				return ["mousemove", String(primitive.at.x), String(primitive.at.y)]
			case "down":
				return ["mousedown", "1"]
			// X keeps the button's state itself.
			case "held":
				return []
			case "up":
				return ["mouseup", "1"]
			case "escape":
				return ["key", "Escape"]
			case "sleep":
				return ["sleep", (primitive.ms / 1000).toFixed(3)]
		}
	})
}

// How long the gesture runs (its pauses), for the helper's time bound.
export function durationMs(primitives: readonly Primitive[]): number {
	return primitives.reduce((sum, primitive) => sum + (primitive.op === "sleep" ? primitive.ms : 0), 0)
}

// Where the page's client point is on the screen, from one pointer event the page saw: its screenX/Y and clientX/Y
// (CSS px). `scale` is OS units per CSS px: devicePixelRatio where the OS counts pixels, 1 on macOS.
export interface Calibration {
	offset: Point
	scale: number
}

export function toScreen(calibration: Calibration, client: Point): Point {
	return whole({
		x: (client.x + calibration.offset.x) * calibration.scale,
		y: (client.y + calibration.offset.y) * calibration.scale
	})
}

export interface Layout {
	app: Rect
	target: Rect
}

// The app's window on the left and the file manager's on the right, side by side and never overlapping: a click on
// the app raises it, and the pointer must leave it over the other. `insets` keep both off a menu bar, Dock or taskbar;
// `appMin` is the app's minimum width in OS units. Null when the screen is too narrow for both.
export function sideBySide(screen: Rect, appMin: number, insets: { top: number; bottom: number }, gap = 24): Layout | null {
	const targetMin = 320
	const margin = 8
	const height = screen.height - insets.top - insets.bottom
	const appWidth = Math.max(appMin, Math.min(Math.round(screen.width * 0.52), screen.width - targetMin - gap - margin * 2))
	const targetX = screen.x + margin + appWidth + gap
	const targetWidth = screen.x + screen.width - margin - targetX

	if (targetWidth < targetMin || height < 480) {
		return null
	}

	const y = screen.y + insets.top

	return {
		app: { x: screen.x + margin, y, width: appWidth, height },
		target: { x: targetX, y, width: targetWidth, height: Math.min(height, Math.round(height * 0.9)) }
	}
}

// Where a drop lands in the file manager's window: right of its sidebar and below its toolbar, in the view's empty
// lower part (dropped items are laid out from the top left; a drop on one would go into it).
export function dropPoint(target: Rect): Point {
	return whole({ x: target.x + target.width * 0.68, y: target.y + target.height * 0.74 })
}
