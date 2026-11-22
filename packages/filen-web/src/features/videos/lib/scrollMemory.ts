// Scroll positions of the Videos views by history entry, so Back returns to where the list was. Session memory only,
// bounded to the most recent entries.

const MAX_ENTRIES = 200

const positions = new Map<string, number>()

export function rememberScroll(key: string, value: number): void {
	positions.delete(key)
	positions.set(key, value)

	if (positions.size > MAX_ENTRIES) {
		const oldest = positions.keys().next().value

		if (oldest !== undefined) {
			positions.delete(oldest)
		}
	}
}

export function recallScroll(key: string): number | undefined {
	return positions.get(key)
}

// Measured heights of windowed rows by row key. A list mounted again lays out the rows it measured before at their
// real heights, not its estimate, so a remembered scroll position lands on the same row.
const MAX_ROW_SIZES = 5000

const rowSizes = new Map<string, number>()

export function rememberRowSize(key: string, size: number): void {
	rowSizes.delete(key)
	rowSizes.set(key, size)

	if (rowSizes.size > MAX_ROW_SIZES) {
		const oldest = rowSizes.keys().next().value

		if (oldest !== undefined) {
			rowSizes.delete(oldest)
		}
	}
}

export function recallRowSize(key: string): number | undefined {
	return rowSizes.get(key)
}

const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const

// Scrolls `element` to `offset`, and again as its content grows (a list mounting, its rows measured) until it gets
// there or the user takes over. Returns the stop.
export function restoreScroll(element: HTMLElement, offset: number): () => void {
	element.scrollTop = offset

	if (element.scrollTop >= offset - 1 || element.children.length === 0 || typeof ResizeObserver === "undefined") {
		return () => undefined
	}

	const observer = new ResizeObserver(() => {
		element.scrollTop = offset

		if (element.scrollTop >= offset - 1) {
			stop()
		}
	})
	const stop = (): void => {
		observer.disconnect()

		for (const type of USER_SCROLL_EVENTS) {
			element.removeEventListener(type, stop)
		}
	}

	// The content grows inside one of these.
	for (const child of element.children) {
		observer.observe(child)
	}

	for (const type of USER_SCROLL_EVENTS) {
		element.addEventListener(type, stop, { passive: true })
	}

	return stop
}
