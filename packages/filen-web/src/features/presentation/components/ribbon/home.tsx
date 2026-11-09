import { useEffect } from "react"
import { ClipboardPasteIcon, PanelTopIcon, SearchIcon, Undo2Icon } from "lucide-react"
import type { ShapeRef } from "@filen/office/core/presentation"
import {
	formatPainterOf,
	selectedShapes,
	useFormatPainter,
	useShapeSelection,
	useTextEditing,
	type FormatPainterHost
} from "@filen/office/react/presentation"
import { FormatPainterButton } from "@/features/office/components/formatPainterButton"
import { TEXT_ROLES, editorOf, type TextRibbonEditor } from "@/features/presentation/components/ribbon/homeText.logic"
import type { PresentationGroups } from "@/features/presentation/components/ribbon/tabs"
import {
	FindMenu,
	LayoutMenu,
	NewSlideControl,
	SectionMenu,
	SlideButtons,
	UndoControls
} from "@/features/presentation/components/slideControls"

// The presentation ribbon's Home groups that are the editor's own: Undo and Redo, Clipboard (the Format Painter for
// text; cut, copy and paste stay with the keys, as the browser keeps clipboard reads from buttons), and the Slides group (New slide
// with its layout menu, Layout, Section, Reset, Duplicate, Delete, Hide), PowerPoint's Home ▸ Slides. A deck that can
// only be viewed offers none of them (it finds with Mod+F). Editing (Find ▾) comes last, after the text groups.

// A button's width with its gap, a dropdown trigger's, as the browsers lay them out (ribbonFit's estimates).
const BUTTON = 30
const MENU = 44
const NEW_SLIDE = 124

// The painter's targets: the selected shapes that hold text, and whether a click on the one selected opens its body.
export function painterTargets(editor: Pick<TextRibbonEditor, "render" | "selection">): FormatPainterHost["targets"] {
	return () => {
		const state = editor.selection.getSnapshot()
		const slide = state.slide
		const selected = selectedShapes(editor.render, state)
		const only = selected.length === 1 ? selected[0] : undefined
		const shapes: ShapeRef[] =
			slide === undefined ? [] : selected.filter(shape => TEXT_ROLES.has(shape.role)).map(shape => ({ slide, id: shape.id }))

		return {
			shapes,
			entersText: only?.body !== undefined && only.body !== "shape" && only.line !== true && only.media === undefined
		}
	}
}

function FormatPainterControl({ editor }: { editor: TextRibbonEditor }) {
	const painter = formatPainterOf(editor.text)
	const mode = useFormatPainter(painter)
	const controller = useTextEditing(editor.text)
	const state = useShapeSelection(editor.selection)
	const targets = painterTargets(editor)
	const host: FormatPainterHost = {
		session: editor.session,
		text: editor.text,
		targets,
		command: op => editor.command(op)
	}
	const copyable =
		controller !== undefined || (state.ids.length > 0 && selectedShapes(editor.render, state).some(shape => TEXT_ROLES.has(shape.role)))

	// The slide's newer render while the painter is on.
	useEffect(() => {
		painter.rebind(host)
	})

	return (
		<FormatPainterButton
			state={mode}
			disabled={mode === "off" && !copyable}
			onCopy={sticky => {
				void painter.copy(host, sticky)
			}}
			onCancel={() => {
				painter.cancel()
			}}
		/>
	)
}

export const homeGroups: PresentationGroups = context => {
	if (!context.editable) return []

	const editor = editorOf(context)

	return [
		{
			id: "history",
			label: context.t("previewOfficeRibbonUndo", { ns: "preview" }),
			icon: Undo2Icon,
			width: 2 * BUTTON,
			priority: Infinity,
			content: <UndoControls />
		},
		...(editor === undefined
			? []
			: [
					{
						id: "clipboard",
						label: context.t("previewOfficeRibbonClipboard", { ns: "preview" }),
						icon: ClipboardPasteIcon,
						width: BUTTON,
						priority: 4,
						single: true,
						content: <FormatPainterControl editor={editor} />
					}
				]),
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
