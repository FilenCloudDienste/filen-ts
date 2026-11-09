// The show's mouse pointer, PowerPoint's "Automatic" arrow option: hidden once the mouse has been still for
// POINTER_IDLE_MS, back on the next move or press. Touch and pen never show or hide it. The stage carries the state as
// data-fo-pointer="hidden" (presentation.css hides the cursor there), so a move never re-renders anything; one timer
// runs at a time and is re-armed only when it fires early, not on every move.

export const POINTER_IDLE_MS = 3000

// Starts hiding the pointer over `stage`; the returned function stops it and shows the pointer again.
export function autoHidePointer(stage: HTMLElement, idleMs = POINTER_IDLE_MS): () => void {
	let last = performance.now()
	let timer: ReturnType<typeof setTimeout> | undefined

	const fire = (): void => {
		const left = last + idleMs - performance.now()

		if (left > 0) {
			timer = setTimeout(fire, left)

			return
		}

		timer = undefined
		stage.setAttribute("data-fo-pointer", "hidden")
	}

	const onPointer = (event: PointerEvent): void => {
		if (event.pointerType !== "mouse") return

		last = performance.now()

		if (timer === undefined) {
			stage.removeAttribute("data-fo-pointer")
			timer = setTimeout(fire, idleMs)
		}
	}

	timer = setTimeout(fire, idleMs)
	stage.addEventListener("pointermove", onPointer, { passive: true })
	stage.addEventListener("pointerdown", onPointer, { passive: true })

	return () => {
		if (timer !== undefined) clearTimeout(timer)

		stage.removeEventListener("pointermove", onPointer)
		stage.removeEventListener("pointerdown", onPointer)
		stage.removeAttribute("data-fo-pointer")
	}
}
