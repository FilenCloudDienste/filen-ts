import type { SlideRef } from "@filen/office/core/presentation"
import type { SlideRender } from "@filen/office/dom/presentation"

// The slide the ribbon acts on: the one in view, whether or not shapes are selected on it (a transition, the timing
// and Insert are the slide's), unless the selection still names another slide (a navigation not settled yet).
export function ribbonSlide(
	render: SlideRender | undefined,
	view: SlideRef | undefined,
	selection: { readonly slide: SlideRef | undefined }
): SlideRender | undefined {
	if (render === undefined || render.ref !== view) return undefined

	return selection.slide === undefined || selection.slide === view ? render : undefined
}
