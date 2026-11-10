// The window's areas F6 moves between, in order: the icon rail, the module sidebar, the content and the assistant.
// Each carries this attribute; one that is not on screen (the sidebar while hidden or narrow, the closed assistant) is
// skipped, and so is one with nothing to focus.
export const PANE_ATTRIBUTE = "data-shell-pane"

const PANE_SELECTOR = `[${PANE_ATTRIBUTE}]`

const TABBABLE_SELECTOR = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled]):not([type='hidden'])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"[contenteditable='true']",
	"[tabindex]:not([tabindex='-1'])"
].join(", ")

// Where focus was in each area when it left, so coming back lands there, as a desktop app's F6 does.
const lastFocused = new WeakMap<Element, HTMLElement>()

function onScreen(element: Element): boolean {
	return element.getClientRects().length > 0
}

function firstTabbable(pane: Element): HTMLElement | null {
	for (const candidate of pane.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)) {
		if (onScreen(candidate)) {
			return candidate
		}
	}

	return null
}

// Where focus goes in an area: where it last was there, else the area's first focusable element.
function entryPoint(pane: Element): HTMLElement | null {
	const remembered = lastFocused.get(pane)

	return remembered !== undefined && remembered.isConnected && pane.contains(remembered) && onScreen(remembered)
		? remembered
		: firstTabbable(pane)
}

// The areas after (or before) the one holding focus, nearest first, wrapping round to it; from outside every area,
// all of them from the first (or the last).
export function panesFrom<T extends Element>(panes: readonly T[], active: Element | null, direction: 1 | -1): T[] {
	const index = active === null ? -1 : panes.findIndex(pane => pane.contains(active))
	const start = index === -1 ? (direction === 1 ? -1 : panes.length) : index
	const order: T[] = []

	for (let step = 1; step <= panes.length; step++) {
		const pane = panes[(start + direction * step + panes.length * 2) % panes.length]

		if (pane !== undefined && pane !== panes[index]) {
			order.push(pane)
		}
	}

	return order
}

// Moves focus to the next area on screen that has something to focus. Returns whether focus moved.
export function cyclePane(direction: 1 | -1): boolean {
	const panes = Array.from(document.querySelectorAll(PANE_SELECTOR)).filter(onScreen)
	const focused = document.activeElement
	const active = focused instanceof HTMLElement && focused !== document.body ? focused : null
	const current = active === null ? undefined : panes.find(pane => pane.contains(active))

	for (const pane of panesFrom(panes, active, direction)) {
		const destination = entryPoint(pane)

		if (destination !== null) {
			if (current !== undefined && active !== null) {
				lastFocused.set(current, active)
			}

			destination.focus()

			return true
		}
	}

	return false
}
