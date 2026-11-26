import { useState, type ReactNode } from "react"
import { cn } from "@filen/shared"
import { ImageShownContext, type ShownImage } from "@/features/preview/lib/imageDisplay"
import { SlideSignalsContext, type SlideshowSlotValue } from "@/features/preview/lib/slideSignals"

interface SlotState {
	readonly value: SlideshowSlotValue
	// One per slide, for the viewers' effects that depend on it.
	readonly report: (image: ShownImage) => void
	readonly shown: boolean
}

// Where a pager's viewer shows under a running slideshow (`value` from useSlideshow; null outside one). The same
// elements whatever `value` is, so the viewer under it never remounts. A slide paged to is hidden until its viewer
// reports it shown, the grid's thumbnail under it meanwhile, then fades in; the thumbnail goes once the fade is done.
export function SlideshowSlot({ value, children }: { value: SlideshowSlotValue | null; children: ReactNode }) {
	const [state, setState] = useState<SlotState | null>(null)
	let current = state

	if (value === null) {
		current = null
	} else if (state?.value !== value) {
		const slide = value

		current = {
			value: slide,
			// The slide a slideshow starts on (after none, or after an item that is no slide) is on screen already.
			shown: (state?.value.signals ?? null) === null,
			report: image => {
				slide.shown(image)
				setState(previous => (previous?.value === slide && !previous.shown ? { ...previous, shown: true } : previous))
			}
		}
	}

	if (current !== state) {
		setState(current)
	}

	// An item that is no slide (paged to by hand) shows as it always does.
	const slide = current !== null && current.value.signals !== null ? current : null
	const revealed = slide === null || slide.shown
	const placeholder = slide === null ? null : slide.value.placeholderUrl

	return (
		<ImageShownContext value={current?.report ?? null}>
			<SlideSignalsContext value={current?.value.signals ?? null}>
				<div className="relative size-full">
					{placeholder === null ? null : (
						<img
							src={placeholder}
							alt=""
							aria-hidden
							draggable={false}
							className={cn(
								"pointer-events-none absolute inset-0 size-full object-contain",
								revealed && "opacity-0 transition-opacity delay-200 duration-0 motion-reduce:delay-0"
							)}
						/>
					)}
					<div
						className={cn(
							"relative size-full",
							revealed ? "opacity-100 transition-opacity duration-200 motion-reduce:transition-none" : "opacity-0"
						)}
					>
						{children}
					</div>
				</div>
			</SlideSignalsContext>
		</ImageShownContext>
	)
}
