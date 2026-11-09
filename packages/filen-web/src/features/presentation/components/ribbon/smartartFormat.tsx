import type { SlideShape } from "@filen/office/react/presentation"
import { sizeGroup } from "@/features/presentation/components/ribbon/sizeControls"
import type { PresentationGroups } from "@/features/presentation/components/ribbon/tabs"

// The SmartArt Format tab: the graphic's frame size (the shared Size group). Its nodes have no format ops of their own.

function isSmartArt(shape: SlideShape): boolean {
	return shape.role === "smartart"
}

export const smartartFormatGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	return [sizeGroup(context, editor, "smartartSize", isSmartArt)]
}
