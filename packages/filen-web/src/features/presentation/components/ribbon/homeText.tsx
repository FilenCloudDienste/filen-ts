import { AlignLeftIcon, TypeIcon } from "lucide-react"
import { FontGroup, ParagraphGroup } from "@/features/presentation/components/ribbon/homeTextControls"
import { ALIGN_COUNT, BUTTON, FONT_PICKER, MENU, SIZE_PICKER, editorOf } from "@/features/presentation/components/ribbon/homeText.logic"
import type { PresentationGroups } from "@/features/presentation/components/ribbon/tabs"

export { presentationTextLabels } from "@/features/presentation/components/ribbon/homeText.logic"

// The presentation ribbon's Home groups for text: Font and Paragraph (homeTextControls.tsx). They need the editor's
// session and text store; a context without them (the viewer, a view-only deck) gets none.
export const homeTextGroups: PresentationGroups = context => {
	const editor = editorOf(context)

	if (editor === undefined || !context.editable) return []

	const t = context.t

	return [
		{
			id: "font",
			label: t("previewPptxTextFontGroup", { ns: "preview" }),
			icon: TypeIcon,
			width: FONT_PICKER + SIZE_PICKER + 12 * BUTTON + 2 * MENU,
			priority: 6,
			content: (
				<FontGroup
					editor={editor}
					editable={context.editable}
				/>
			)
		},
		{
			id: "paragraph",
			label: t("previewPptxTextParagraphGroup", { ns: "preview" }),
			icon: AlignLeftIcon,
			width: (4 + ALIGN_COUNT + 2) * BUTTON + 6 * MENU,
			priority: 5,
			content: (
				<ParagraphGroup
					editor={editor}
					editable={context.editable}
				/>
			)
		}
	]
}
