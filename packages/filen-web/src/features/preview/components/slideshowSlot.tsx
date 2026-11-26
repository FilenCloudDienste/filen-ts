import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { cn } from "@filen/shared"
import { ImageShownContext } from "@/features/preview/lib/imageDisplay"
import { SlideSignalsContext, type SlideshowSlotValue } from "@/features/preview/lib/slideSignals"

// How long a slide fades in; the thumbnail under it goes after.
const FADE_MS = 200

function subscribeNothing(): () => void {
	return () => undefined
}

function alwaysVisible(): boolean {
	return true
}

// Where a pager's viewer shows under a running slideshow (`value` from useSlideshow; null outside one). The same
// elements whatever `value` is, so the viewer under it never remounts. A slide is hidden until it is to be seen
// (value.visible), the grid's thumbnail under it meanwhile, then fades in; the thumbnail is dropped once the fade is
// done. An item that is no slide (paged to by hand) shows as it always does. Outside a slideshow the wrappers lay
// nothing out (display: contents), so the viewer sits exactly as it does without them.
export function SlideshowSlot({ value, children }: { value: SlideshowSlotValue | null; children: ReactNode }) {
	const slide = value !== null && value.signals !== null ? value : null
	const visible = useSyncExternalStore(slide?.subscribe ?? subscribeNothing, slide?.visible ?? alwaysVisible, alwaysVisible)
	const [faded, setFaded] = useState<SlideshowSlotValue | null>(null)

	useEffect(() => {
		if (slide === null || !visible) {
			return
		}

		const timer = setTimeout(() => {
			setFaded(slide)
		}, FADE_MS)

		return () => {
			clearTimeout(timer)
		}
	}, [slide, visible])

	const placeholder = slide !== null && faded !== slide ? slide.placeholderUrl : null

	return (
		<ImageShownContext value={value?.shown ?? null}>
			<SlideSignalsContext value={value?.signals ?? null}>
				<div className={value === null ? "contents" : "relative size-full"}>
					{placeholder === null ? null : (
						<img
							src={placeholder}
							alt=""
							aria-hidden
							draggable={false}
							className="pointer-events-none absolute inset-0 size-full object-contain"
						/>
					)}
					<div
						className={
							value === null
								? "contents"
								: cn(
										"relative size-full",
										visible ? "opacity-100 transition-opacity duration-200 motion-reduce:transition-none" : "opacity-0"
									)
						}
					>
						{children}
					</div>
				</div>
			</SlideSignalsContext>
		</ImageShownContext>
	)
}
