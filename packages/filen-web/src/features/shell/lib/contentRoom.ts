// The room the shell row leaves for the content card and a route's side panel together: the card's width, plus the
// side-panel slot's and the gap before it while the slot holds a panel. A side panel decides from this whether it fits
// beside the card (sidePanelLayout.ts); counting the slot back in keeps that answer stable while the panel shows.
// Measured by one ResizeObserver on the two elements (layout-driven, never per frame); listeners hear every change and
// derive their own answer, so a consumer re-renders only when that answer flips.

// The shell row's gap-2 (appShell.tsx), between the card and the slot.
export const SHELL_ROW_GAP_PX = 8

type Part = "main" | "slot"

const widths: Record<Part, number> = { main: 0, slot: 0 }
const parts = new Map<Element, Part>()
const listeners = new Set<() => void>()
let room = 0
let observer: ResizeObserver | null = null

function recompute(): void {
	const next = widths.main + (widths.slot > 0 ? widths.slot + SHELL_ROW_GAP_PX : 0)

	if (next === room) {
		return
	}

	room = next

	for (const listener of listeners) {
		listener()
	}
}

function getObserver(): ResizeObserver {
	observer ??= new ResizeObserver(entries => {
		for (const entry of entries) {
			const part = parts.get(entry.target)

			if (part !== undefined) {
				widths[part] = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width
			}
		}

		recompute()
	})

	return observer
}

// A ref callback for the content card ("main") or the side-panel slot ("slot"). Measured at once, so the first render
// after mount already knows the room, then on every resize.
export function contentRoomRef(part: Part): (element: HTMLElement | null) => (() => void) | undefined {
	return element => {
		if (element === null) {
			return undefined
		}

		parts.set(element, part)
		widths[part] = element.getBoundingClientRect().width
		getObserver().observe(element)
		recompute()

		return () => {
			getObserver().unobserve(element)
			parts.delete(element)
			widths[part] = 0
			recompute()
		}
	}
}

export function contentRoomWidth(): number {
	return room
}

export function subscribeToContentRoom(listener: () => void): () => void {
	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}
