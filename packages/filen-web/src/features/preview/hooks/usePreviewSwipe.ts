import { useRef, type MouseEvent, type PointerEvent } from "react"
import { createShowSwipe, type ShowSwipe } from "@filen/office/react/presentation"
import { useLatestRef } from "@/lib/useLatestRef"
import { swipeStartsOn } from "@/features/preview/components/previewOverlay.logic"

export interface PreviewSwipeHandlers {
	onPointerDown: (event: PointerEvent<HTMLElement>) => void
	onPointerUp: (event: PointerEvent<HTMLElement>) => void
	onPointerCancel: (event: PointerEvent<HTMLElement>) => void
	onClickCapture: (event: MouseEvent<HTMLElement>) => void
}

// A touch swipe across the picture pages the preview (leftwards to the next file), as a deck's show does with its
// slides; the click the swipe ends in is swallowed. Only where `enabled` and on a picture at its fitted size
// (swipeStartsOn); a second finger (a pinch) drops it.
export function usePreviewSwipe(enabled: boolean, step: (delta: 1 | -1) => void): PreviewSwipeHandlers {
	const stepRef = useLatestRef(step)
	const swipeRef = useRef<ShowSwipe | null>(null)

	function swipe(): ShowSwipe {
		swipeRef.current ??= createShowSwipe({
			next: () => {
				stepRef.current(1)
			},
			prev: () => {
				stepRef.current(-1)
			}
		})

		return swipeRef.current
	}

	return {
		onPointerDown: event => {
			if (enabled && swipeStartsOn(event.target)) {
				swipe().onPointerDown(event)
			} else {
				swipe().onPointerCancel(event)
			}
		},
		onPointerUp: event => {
			swipe().onPointerUp(event)
		},
		onPointerCancel: event => {
			swipe().onPointerCancel(event)
		},
		onClickCapture: event => {
			swipe().onClickCapture(event)
		}
	}
}
