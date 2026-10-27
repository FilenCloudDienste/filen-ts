import { PanelTopIcon, SearchIcon, Undo2Icon } from "lucide-react"
import type { PresentationGroups } from "@/features/presentation/components/ribbon/tabs"
import {
	FindMenu,
	LayoutMenu,
	NewSlideControl,
	SectionMenu,
	SlideButtons,
	UndoControls
} from "@/features/presentation/components/slideControls"

// The presentation ribbon's Home groups that are the editor's own: Undo and Redo, and the Slides group (New slide
// with its layout menu, Layout, Section, Reset, Duplicate, Delete, Hide), PowerPoint's Home ▸ Slides. A deck that can
// only be viewed offers none of them (it finds with Mod+F). Editing (Find ▾) comes last, after the text groups.

// A button's width with its gap, a dropdown trigger's, as the browsers lay them out (ribbonFit's estimates).
const BUTTON = 30
const MENU = 44
const NEW_SLIDE = 124

export const homeGroups: PresentationGroups = context => {
	if (!context.editable) return []

	return [
		{
			id: "history",
			label: context.t("previewOfficeRibbonUndo", { ns: "preview" }),
			icon: Undo2Icon,
			width: 2 * BUTTON,
			priority: Infinity,
			content: <UndoControls />
		},
		{
			id: "slides",
			label: context.t("previewPptxRibbonSlides", { ns: "preview" }),
			icon: PanelTopIcon,
			width: NEW_SLIDE + 2 * MENU + 4 * BUTTON,
			priority: 6,
			content: (
				<>
					<NewSlideControl />
					<LayoutMenu />
					<SectionMenu />
					<SlideButtons />
				</>
			)
		}
	]
}

// Home's last group, after the text groups: Editing (Find ▾), as in the document editor.
export const homeEditingGroups: PresentationGroups = context =>
	context.editable
		? [
				{
					id: "editing",
					label: context.t("previewOfficeRibbonEditing", { ns: "preview" }),
					icon: SearchIcon,
					width: MENU,
					priority: 2,
					single: true,
					content: <FindMenu />
				}
			]
		: []
