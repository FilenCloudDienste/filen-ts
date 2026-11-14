import { useState, type KeyboardEvent } from "react"
import { placementKey, placementStart, type PlacementPage, type PlacementRect } from "./keyboardPlacement"

// Keyboard placement (keyboardPlacement.ts) for one tool on one page: start() puts the rectangle down, the page's
// keydown handler steps it, and commit or cancel ends it. The host draws `rect` (its indicator) and announces its
// position (placementPosition) in a live region.

export interface KeyboardPlacementOptions {
	readonly page: PlacementPage
	readonly size: { readonly width: number; readonly height: number }
	readonly onCommit: (rect: PlacementRect) => void
	readonly onCancel?: () => void
}

export interface KeyboardPlacement {
	// The rectangle being placed, or null.
	readonly rect: PlacementRect | null
	// Puts it down at the page's centre, or centred on `at`.
	start(at?: { readonly x: number; readonly y: number }): void
	// The focused page's keydown: true when placement took the key (it is then kept from everything else).
	onKeyDown(event: KeyboardEvent): boolean
}

export function useKeyboardPlacement(options: KeyboardPlacementOptions): KeyboardPlacement {
	const [rect, setRect] = useState<PlacementRect | null>(null)

	return {
		rect,
		start: at => {
			setRect(placementStart(options.page, options.size, at))
		},
		onKeyDown: event => {
			if (rect === null || event.nativeEvent.isComposing) return false

			const step = placementKey(rect, options.page, event)

			if (step === null) return false

			event.preventDefault()
			event.stopPropagation()

			if (step.kind === "move") setRect(step.rect)
			else {
				setRect(null)

				if (step.kind === "commit") options.onCommit(rect)
				else options.onCancel?.()
			}

			return true
		}
	}
}
