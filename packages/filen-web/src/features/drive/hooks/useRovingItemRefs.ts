import { useRef } from "react"

// Bounds the rAF poll focusItem() uses to focus a target that scrollToIndex just brought into range
// but that hasn't mounted (and registered its ref) yet.
const FOCUS_RETRY_FRAMES = 10

export interface RovingItemRefs {
	registerRef: (index: number, el: HTMLDivElement | null) => void
	focusItem: (index: number) => void
}

// The per-index DOM ref map a virtualized roving-tabindex listbox focuses into. Focus is imperative by
// nature here: the target may be scrolled fully out of the mounted window, and scrollToIndex's
// re-render lands through the virtualizer's own scroll subscription, not synchronously with the
// caller's state update. A bounded rAF poll picks the item up once it mounts; `focusRequestRef` makes
// an older, still-polling request inert once a newer one lands.
export function useRovingItemRefs(): RovingItemRefs {
	const itemRefs = useRef(new Map<number, HTMLDivElement>())
	const focusRequestRef = useRef(0)

	function registerRef(index: number, el: HTMLDivElement | null): void {
		if (el) {
			itemRefs.current.set(index, el)
		} else {
			itemRefs.current.delete(index)
		}
	}

	function focusItem(index: number): void {
		focusRequestRef.current = index

		const attemptFocus = (attemptsLeft: number) => {
			if (focusRequestRef.current !== index) {
				return
			}

			const el = itemRefs.current.get(index)

			if (el) {
				if (document.activeElement !== el) {
					el.focus({ preventScroll: true })
				}

				return
			}

			if (attemptsLeft <= 0) {
				return
			}

			requestAnimationFrame(() => {
				attemptFocus(attemptsLeft - 1)
			})
		}

		requestAnimationFrame(() => {
			attemptFocus(FOCUS_RETRY_FRAMES)
		})
	}

	return { registerRef, focusItem }
}
