import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { usePreviewTextFile, type TextState } from "@/features/preview/hooks/usePreviewTextFile"
import { usePreviewTextDocument } from "@/features/preview/hooks/usePreviewTextDocument"
import type { TextBuffer, TextFile } from "@/features/preview/lib/textFile"
import { useCodeMirrorTransformHost } from "@/features/preview/lib/codeMirrorTransformHost"
import { elementSelection } from "@/lib/activeDocument"
import { CodeSurface } from "@/features/preview/components/codeSurface"
import {
	MarkdownRenderedBar,
	type MarkdownBar,
	type MarkdownMode,
	type RenderedViewLabels
} from "@/features/preview/components/codeCommandBar"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { usePreviewDownload } from "@/features/preview/lib/accessMode"
import { useLeaveViewerFullScreen } from "@/features/preview/components/commandBar.logic"
import { onCommandBarF6, onRibbonEscape } from "@/features/office/components/ribbon/ribbonFocus"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useEditorLayerKeys } from "@/lib/keymap/editorLayerKeys"
import { keyForEditor } from "@/lib/keymap/dialogGuard"
import { IN_EDITORS, useAction } from "@/lib/keymap/useAction"
import { PreviewErrorState, PreviewLoading, PreviewNotTextState } from "@/features/preview/components/previewErrorState"
import type { LivePreviewHost } from "@/features/preview/hooks/useLivePreview"
import { getMarkdownView, livePreviewFits, setMarkdownView, type MarkdownViewChoice } from "@/features/preview/lib/markdownView"

// What the rendered view is drawn from: the file's bytes and its text, decoded once and shared with Source.
export interface RenderedSource {
	readonly bytes: Uint8Array
	readonly file: TextFile
}

export interface RenderedSourceViewerProps {
	item: DriveItem
	alt: string
	// The rendered view (Rendered | Source): pass a module-scope function.
	renderer: (source: RenderedSource) => ReactNode
	// Source's grammar (codeMirrorLanguageFor), and whether its bar offers markdown formatting.
	tag: string
	formatting: boolean
	// The switch's names.
	labels: RenderedViewLabels
	// Same optional props TextViewer accepts — forwarded to the source-mode editor only. The
	// rendered arm is never an editing surface.
	editable?: boolean
	onDirtyChange?: (dirty: boolean) => void
	contentRef?: RefObject<TextBuffer | null>
	// Read-only while the overlay saves: see CodeMirrorSource's own prop.
	locked?: boolean
	// See TextViewer's own prop.
	onTextState?: (state: TextState) => void
	// The codepage this version is known to be in (this open saved it so): read without asking the detector again.
	readAs?: string | null
	// Published as the open document (markdown; not the formats that render data, such as a calendar).
	publishes?: boolean
	// A markdown document's live preview (useLivePreview): its editing view is Live preview or Source, the switch Read
	// and that view's menu (markdownView.ts). Without it: Rendered | Source.
	livePreview?: LivePreviewHost
}

// A text-family file shown rendered, with its source a toggle away (markdown; diagrams, calendars and the like render
// through it too). Top-level gate on the whole-buffer download and the binary check (usePreviewTextFile, shared with
// the text viewer) — decodes ONCE here and feeds both views, so flipping modes never downloads again. The
// editor seeds from `text` at mount, which is safe to repeat: the toggle is locked while dirty, and a
// save rotates the uuid, remounting this whole viewer onto the new bytes.
// No parameter defaults: the React Compiler skips a component that has them.
export function RenderedSourceViewer({
	item,
	alt,
	renderer,
	tag,
	formatting,
	labels,
	editable,
	onDirtyChange,
	contentRef,
	locked,
	onTextState,
	readAs,
	publishes,
	livePreview
}: RenderedSourceViewerProps) {
	const text = usePreviewTextFile(item, editable === true, onTextState, readAs ?? null)
	const download = usePreviewDownload()

	useLeaveViewerFullScreen()
	// Rendered | Source, without a live preview.
	const [plainMode, setPlainMode] = useState<MarkdownMode>("rendered")
	// With one: the device's choice as this open found it, then the user's here; `chosen` once they switched (until
	// then a file that cannot be edited opens in Read).
	const [choice, setChoice] = useState<MarkdownViewChoice>(getMarkdownView)
	const [chosen, setChosen] = useState(false)
	const loaded = text.status === "success" ? text : null
	const canEdit = editable === true && loaded?.writable === true
	const liveAvailable = loaded === null || livePreviewFits(loaded.file.text)
	const editMode = liveAvailable ? choice.edit : "source"
	const reading = chosen ? choice.read : !canEdit || choice.read
	const mode: MarkdownMode = livePreview === undefined ? plainMode : reading ? "rendered" : editMode
	const setMode = (next: MarkdownMode): void => {
		if (livePreview === undefined) {
			setPlainMode(next === "live" ? "source" : next)

			return
		}

		const nextChoice: MarkdownViewChoice = next === "rendered" ? { edit: choice.edit, read: true } : { edit: next, read: false }

		setChosen(true)
		setChoice(nextChoice)
		setMarkdownView(nextChoice)
	}
	// Where focus goes after a keyboard toggle: into the source editor, or onto the command bar's switch when
	// the toggle unmounted the editor that had it.
	const [focusAfterToggle, setFocusAfterToggle] = useState<"editor" | "toggle" | null>(null)
	const containerRef = useRef<HTMLDivElement>(null)
	const toggleRef = useRef<HTMLButtonElement>(null)
	// Toggling back to rendered UNMOUNTS the source-mode editor, and CodeMirrorSource only reports the
	// dirty bit from a mount-time/dirty-edge effect — never on unmount — so an ungated toggle would both
	// discard the buffer and strand the overlay's dirty flag. Read from the guard store, the single
	// definition the overlay's own Save button reads too.
	const dirty = usePreviewUnsavedGuardStore(state => state.dirty)

	// Locked while dirty, like the command bar's switch (see above). The key is swallowed even then:
	// left to the browser, Ctrl+Shift+V pastes the clipboard over the selection, which is not what
	// pressing the toggle asks for. Works with the cursor in the editor too, but only in the viewer's own
	// layer: a dialog over it, or a native field, keeps the key.
	useAction(
		"editor.togglePreview",
		keyboardEvent => {
			const root = containerRef.current

			if (root === null || !keyForEditor(root, keyboardEvent.target)) {
				return
			}

			keyboardEvent.preventDefault()

			if (dirty) {
				return
			}

			const focusInside = containerRef.current?.contains(document.activeElement) ?? false

			setFocusAfterToggle(mode === "rendered" ? "editor" : focusInside ? "toggle" : null)
			setMode(mode === "rendered" ? editMode : "rendered")
		},
		IN_EDITORS,
		[dirty, mode, editMode, choice, chosen]
	)

	// Live preview and Source, one editor reconfigured: never locked. From Read, into the other editing view.
	useAction(
		"editor.toggleLivePreview",
		keyboardEvent => {
			const root = containerRef.current

			if (livePreview === undefined || root === null || !keyForEditor(root, keyboardEvent.target)) {
				return
			}

			keyboardEvent.preventDefault()

			if (!liveAvailable) {
				return
			}

			if (mode === "rendered") {
				setFocusAfterToggle("editor")
			}

			setMode(editMode === "live" ? "source" : "live")
		},
		IN_EDITORS,
		[livePreview, liveAvailable, mode, editMode, choice]
	)

	useEffect(() => {
		if (focusAfterToggle === "toggle" && mode === "rendered") {
			toggleRef.current?.focus()
		}
	}, [focusAfterToggle, mode])

	// The rendered pane: the host's own focus stop, so Escape and F6 land somewhere whatever the renderer draws. Null in
	// Source, whose editor surface answers both keys itself.
	const renderedRef = useRef<HTMLDivElement>(null)
	// The selection for the open document: the source editor's, or the rendered pane's text.
	const { host: sourceSelection, onView } = useCodeMirrorTransformHost()
	const [rendered] = useState(elementSelection)

	useEffect(() => {
		rendered.attach(renderedRef.current)
	})
	usePreviewTextDocument(text, contentRef, editable === true, publishes === true, mode === "rendered" ? rendered.reader : sourceSelection)

	// The renderer's top document when it is focusable itself (markdown's), else the pane. Only the first document
	// counts: one nested in a non-focusable document (a notebook's markdown cell) is not the landing.
	const focusDocument = (): void => {
		const pane = renderedRef.current
		const first = pane?.querySelector<HTMLElement>('[role="document"]')
		const target = first?.hasAttribute("tabindex") === true ? first : pane

		target?.focus()
	}

	// F6 pressed elsewhere in the viewer's layer (focus left on the preview overlay itself after a click, as Safari and
	// macOS Firefox do).
	useEditorLayerKeys(containerRef, (event, root) => {
		if (renderedRef.current !== null) {
			onCommandBarF6(event, root, focusDocument)
		}
	})

	if (text.status === "pending") {
		return <PreviewLoading />
	}

	if (text.status === "error") {
		return (
			<PreviewErrorState
				message={errorLabel(text.dto)}
				onRetry={text.refetch}
			/>
		)
	}

	if (text.status === "notText") {
		return (
			<PreviewNotTextState
				item={item}
				onShowAnyway={text.showAnyway}
			/>
		)
	}

	const { file, writable, encoding } = text
	const bar: MarkdownBar = {
		mode,
		labels,
		formatting,
		locked: dirty,
		switchRef: toggleRef,
		onMode: next => {
			setFocusAfterToggle(null)
			setMode(next)
		},
		live: livePreview === undefined ? undefined : { editMode, available: liveAvailable }
	}

	return (
		<div
			ref={containerRef}
			className="flex size-full flex-col"
			// The source's F6 is the editor surface's own (it takes the key first).
			onKeyDownCapture={event => {
				if (renderedRef.current !== null) {
					onRibbonEscape(event, event.currentTarget, focusDocument, "capture")
				}
			}}
			onKeyDown={event => {
				if (renderedRef.current !== null && !onRibbonEscape(event, event.currentTarget, focusDocument, "bubble"))
					onCommandBarF6(event, event.currentTarget, focusDocument)
			}}
		>
			{livePreview?.node}
			{mode !== "rendered" ? (
				<CodeSurface
					// Reopened with another encoding: a new text, so a new editor.
					key={encoding.chosen ?? ""}
					file={file}
					encoding={encoding}
					tag={tag}
					alt={alt}
					editable={editable === true && writable}
					locked={locked ?? false}
					autoFocus={focusAfterToggle === "editor"}
					markdown={bar}
					onDirtyChange={onDirtyChange}
					contentRef={contentRef}
					onView={onView}
					livePreview={mode === "live" ? livePreview?.extension : null}
				/>
			) : (
				<>
					<MarkdownRenderedBar
						markdown={bar}
						onDownload={download}
					/>
					<div
						ref={renderedRef}
						tabIndex={-1}
						className="min-h-0 flex-1 outline-none"
					>
						{renderer({ bytes: text.bytes, file })}
					</div>
				</>
			)}
		</div>
	)
}
