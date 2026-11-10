import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode, type Ref } from "react"
import type { DocxKeyBindings, PagedEditor } from "../../../core/docx/paged/index"
import type { DocxEditorHandle, DocxEditorInteractions } from "../DocxEditor"
import type { DocxEditorMark } from "../edit/surface"
import type { DocxMarkLabels } from "../paint/marks"
import type { DocxDocument } from "../store"
import { ReflowView, type ReflowViewOptions } from "./view"

// The document being edited reflowed to the width of its box (a phone's "Mobile view"), editable in place of
// the pages: the session's text in a visible editing view, styled from the document's resolved properties, the
// blocks in view mounted, notes at their references, pictures and tables fitted to the width. The paged layout
// rests meanwhile (PagedEditor.suspend). State shows as data-* attributes, the look as --fo-* variables.

export interface DocxReflowProps {
	readonly editor: PagedEditor
	// The renderer's side of the same document (its media).
	readonly document: DocxDocument
	readonly className?: string
	// The accessible name of the editing area.
	readonly label: string
	// The id of an element describing it (how to leave it from the keyboard).
	readonly describedBy?: string
	readonly readOnly?: boolean
	// Cmd as the shortcut modifier (Apple platforms).
	readonly apple?: boolean
	// In the desktop app: the shortcuts the browser owns are the editor's (Word's line spacing). Read for the default
	// keys only.
	readonly desktop?: boolean
	// The Word keys in effect, by DOCX_KEYS id (a host's keymap); Word's on this platform without them.
	readonly keyBindings?: DocxKeyBindings
	// Find requested (Mod+F), or Find and Replace (Ctrl+H): the app's own find.
	readonly onFind?: (replace: boolean) => void
	// Ranges to mark (spelling, search results).
	readonly marks?: readonly DocxEditorMark[]
	// Presses on objects in the text, by kind (a press's page is -1 and its page coordinates 0 here).
	readonly interactions?: DocxEditorInteractions
	// The accessible name of a note's or text box's text shown at its reference.
	readonly storyLabel?: (kind: "footnote" | "endnote" | "textbox", mark: string) => string
	// The words formatting marks label breaks with (PagedEditor.formattingMarks shows them), English by default.
	readonly markLabels?: DocxMarkLabels
	// The same handle the paged editor fills.
	readonly ref?: Ref<DocxEditorHandle>
}

const EMPTY_MARKS: readonly DocxEditorMark[] = []

export function DocxReflow(props: DocxReflowProps): ReactNode {
	const { editor, ref } = props
	const scrollerRef = useRef<HTMLDivElement | null>(null)
	const viewRef = useRef<ReflowView | null>(null)
	const options: ReflowViewOptions = {
		label: props.label,
		describedBy: props.describedBy,
		readOnly: props.readOnly === true,
		apple: props.apple === true,
		desktop: props.desktop === true,
		keyBindings: props.keyBindings,
		onFind: props.onFind,
		marks: props.marks ?? EMPTY_MARKS,
		interactions: props.interactions,
		document: props.document,
		storyLabel: props.storyLabel,
		markLabels: props.markLabels
	}
	const optionsRef = useRef(options)

	useImperativeHandle(ref, () => ({
		focus: () => viewRef.current?.focus(),
		scrollToCaret: () => viewRef.current?.scrollToCaret(),
		scrollToPage: index => viewRef.current?.scrollToPage(index),
		// No pages here: the page's share of the document.
		goToPage: index => viewRef.current?.scrollToPage(index),
		selectionPoints: () => viewRef.current?.selectionPoints() ?? { start: undefined, end: undefined },
		dragSelectionEnd: (end, clientX, clientY) => viewRef.current?.dragSelectionEnd(end, clientX, clientY),
		endSelectionDrag: () => viewRef.current?.endSelectionDrag(),
		hitTest: (clientX, clientY) => viewRef.current?.hitTest(clientX, clientY),
		clipboardContent: () => viewRef.current?.clipboardContent(),
		deleteSelection: () => viewRef.current?.deleteSelection() ?? false,
		paste: content => viewRef.current?.paste(content) ?? false,
		selectAll: () => viewRef.current?.selectAll() ?? false,
		scrollElement: () => scrollerRef.current
	}))

	// The view, for the editor's lifetime; what changes later reaches it through update().
	useEffect(() => {
		const scroller = scrollerRef.current

		if (scroller === null) return

		const view = new ReflowView(editor, scroller, optionsRef.current)

		viewRef.current = view

		return () => {
			view.destroy()
			viewRef.current = null
		}
	}, [editor])

	// Unmounted with focus: handed on before the view leaves the document (passive cleanups run after).
	useLayoutEffect(
		() => () => {
			viewRef.current?.releaseFocus()
		},
		[]
	)

	useLayoutEffect(() => {
		optionsRef.current = options
		viewRef.current?.update(options)
	})

	return (
		<div
			ref={scrollerRef}
			className={props.className === undefined ? "fo-docx-reflow" : `fo-docx-reflow ${props.className}`}
			data-fo-editing=""
			data-fo-status={props.document.status}
			{...(props.readOnly === true || editor.session.readOnly ? { "data-fo-read-only": "" } : {})}
		/>
	)
}
