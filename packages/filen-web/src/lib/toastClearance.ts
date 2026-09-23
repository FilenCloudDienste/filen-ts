import { useSyncExternalStore } from "react"
import { computeToastClearance } from "@/lib/toastClearance.logic"

// Single source of truth for how far toasts must lift: surfaces that can sit in the bottom-right toast
// corner (floating selection bars, the docked audio player, the chat composer) register their root
// element while mounted, and the Toaster reads the measured clearance. Nothing registered — public-link
// routes, an idle shell — reads 0, i.e. sonner's normal flush offset.
const obstructions = new Map<Element, ResizeObserver>()
const listeners = new Set<() => void>()
let clearance = 0
let frame: number | null = null

function measure(): void {
	const next = computeToastClearance({
		obstructions: Array.from(obstructions.keys(), element => element.getBoundingClientRect()),
		viewport: {
			width: window.innerWidth,
			height: window.innerHeight
		}
	})

	if (next === clearance) {
		return
	}

	clearance = next

	for (const listener of listeners) {
		listener()
	}
}

// Deferred to the next frame for changes that move an obstruction without resizing it — another bar
// mounting/unmounting reflows the shell, a viewport resize moves the docked player's top edge.
function scheduleMeasure(): void {
	if (frame !== null) {
		return
	}

	frame = requestAnimationFrame(() => {
		frame = null
		measure()
	})
}

// React 19 ref callback (returns its own cleanup), so call sites need no hook: `ref={toastObstructionRef}`.
// The parent is observed too because a centered bar keeps its size while its wrapper resizes around it
// (sidebar drag, window resize), which moves it into or out of the toast column.
export function toastObstructionRef(element: HTMLElement | null): (() => void) | undefined {
	if (element === null) {
		return undefined
	}

	const observer = new ResizeObserver(measure)

	observer.observe(element)

	if (element.parentElement !== null) {
		observer.observe(element.parentElement)
	}

	if (obstructions.size === 0) {
		window.addEventListener("resize", scheduleMeasure)
	}

	obstructions.set(element, observer)
	scheduleMeasure()

	return () => {
		observer.disconnect()
		obstructions.delete(element)

		if (obstructions.size === 0) {
			window.removeEventListener("resize", scheduleMeasure)
		}

		scheduleMeasure()
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}

function getClearance(): number {
	return clearance
}

// Pixels between the viewport's bottom edge and the top of the highest obstruction in the toast column.
export function useToastClearance(): number {
	return useSyncExternalStore(subscribe, getClearance, () => 0)
}
