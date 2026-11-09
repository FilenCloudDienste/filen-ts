// The show's mouse pointer, PowerPoint's "Automatic" arrow option: hidden once the mouse has been still for
// POINTER_IDLE_MS, back on the next move or press. Touch and pen never show or hide it. The stage carries the state as
// data-fo-pointer="hidden" (presentation.css hides the cursor there), so a move never re-renders anything; one timer
// runs at a time and is re-armed only when it fires early, not on every move.

export const POINTER_IDLE_MS = 3000

// PowerPoint's other arrow options, set from the keys: "hide" (Ctrl+H: hidden until shown), "automatic" (Ctrl+A:
// shown now, hidden again once still) and "toggle" (A or =: hidden, or else always shown).
export type PointerChange = "hide" | "automatic" | "toggle"

const HIDDEN = "data-fo-pointer"

// The parts of the stage element and its pointer events used here (structural, so the keys, which name
// PointerChange, type-check without the DOM lib).
export interface PointerInput {
	readonly pointerType: string
}

export interface PointerStage {
	getAttribute(name: string): string | null
	setAttribute(name: string, value: string): void
	removeAttribute(name: string): void
	addEventListener(type: "pointermove" | "pointerdown", listener: (event: PointerInput) => void, options: { passive: boolean }): void
	removeEventListener(type: "pointermove" | "pointerdown", listener: (event: PointerInput) => void): void
}

// A stage's manual mode (none: automatic) and its running auto-hide's re-arm.
const modes = new WeakMap<PointerStage, "hidden" | "visible">()
const rearms = new WeakMap<PointerStage, () => void>()

export function changePointer(stage: PointerStage, change: PointerChange): void {
	const mode =
		change === "hide" ? "hidden" : change === "automatic" ? undefined : stage.getAttribute(HIDDEN) === "hidden" ? "visible" : "hidden"

	if (mode === undefined) modes.delete(stage)
	else modes.set(stage, mode)

	if (mode === "hidden") stage.setAttribute(HIDDEN, "hidden")
	else stage.removeAttribute(HIDDEN)

	if (mode === undefined) rearms.get(stage)?.()
}

// Starts hiding the pointer over `stage`; the returned function stops it and shows the pointer again. A manual mode
// (changePointer) holds until the keys return it to automatic.
export function autoHidePointer(stage: PointerStage, idleMs = POINTER_IDLE_MS): () => void {
	let last = performance.now()
	let timer: ReturnType<typeof setTimeout> | undefined

	const fire = (): void => {
		if (modes.has(stage)) {
			timer = undefined

			return
		}

		const left = last + idleMs - performance.now()

		if (left > 0) {
			timer = setTimeout(fire, left)

			return
		}

		timer = undefined
		stage.setAttribute(HIDDEN, "hidden")
	}

	const show = (): void => {
		last = performance.now()

		if (timer === undefined) {
			stage.removeAttribute(HIDDEN)
			timer = setTimeout(fire, idleMs)
		}
	}

	const onPointer = (event: PointerInput): void => {
		if (event.pointerType === "mouse" && !modes.has(stage)) show()
	}

	timer = setTimeout(fire, idleMs)
	rearms.set(stage, show)
	stage.addEventListener("pointermove", onPointer, { passive: true })
	stage.addEventListener("pointerdown", onPointer, { passive: true })

	return () => {
		if (timer !== undefined) clearTimeout(timer)

		rearms.delete(stage)
		modes.delete(stage)
		stage.removeEventListener("pointermove", onPointer)
		stage.removeEventListener("pointerdown", onPointer)
		stage.removeAttribute(HIDDEN)
	}
}
