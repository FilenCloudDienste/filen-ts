import { useEffect, useRef, useState, type RefObject } from "react"
import CodeMirror, { ExternalChange, type ReactCodeMirrorRef } from "@uiw/react-codemirror"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { useCodeMirrorTheme, useEditorKeymap, useLanguageExtension } from "@/features/preview/lib/codeMirrorShared"

// Shared CodeMirror read/write surface — extracted from textViewer.tsx so the notes reader (and the
// notes editor) reuses the SAME language-loader/theme plumbing (lib/codeMirrorShared.ts) as file preview
// rather than a second copy. Preview's own textViewer.tsx is this module's regression net (its e2e/unit coverage did
// not change shape, only its import path did).

export interface CodeMirrorSourceProps {
	text: string
	tag: string
	alt: string
	// Writable mode for the preview-save feature — omitted (or false) by every read-only caller (the
	// notes reader) so those need no changes.
	editable?: boolean
	// Fired whenever the dirty bit flips (never on every keystroke) — a read-only caller can omit this
	// entirely (defaults to a no-op below), since the doc can only diverge from `text` through an edit,
	// itself editable-gated.
	onDirtyChange?: (dirty: boolean) => void
	// Side channel for a Save handler to read the CURRENT buffer on demand without this component
	// re-rendering its parent on every keystroke: a reader, so the doc is flattened into a string only
	// when someone asks, never per keystroke. Null while not editable. Still answers with the last buffer
	// after unmount (a destroyed view keeps its final state).
	contentRef?: RefObject<(() => string) | null>
	// Per-change callback (editable-only): fires the CURRENT buffer on EVERY change, not just the
	// dirty edge — the notes editor's immediate-persist rule enqueues on every keystroke, unlike the
	// preview save path that reads on demand via contentRef. Read-only callers omit it (never fires).
	onValueChange?: (value: string) => void
	// Focus the editor once it is created.
	autoFocus?: boolean
	// Read-only for now, keeping the buffer: the preview's save in flight, which remounts the editor on
	// what it uploaded, so anything typed meanwhile would be lost.
	locked?: boolean
}

const LOCKED: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false)]

// Its own compartment, swapped alone: the editable/readOnly props would rebuild the whole configuration.
// Compartment contents survive the wrapper's own full reconfigures (theme, language).
function emptyCompartment(): { compartment: Compartment; initial: Extension } {
	const compartment = new Compartment()

	return { compartment, initial: compartment.of([]) }
}

const BASIC_SETUP = { searchKeymap: false }

// CodeMirror splits the doc on CR, LF and CRLF and joins it with LF, so a seed carrying CR differs from
// its own doc: @uiw then replaces the whole doc with it again at mount, a second full copy that the undo
// history keeps and a full reparse. Seeding it already joined gives the same doc without that.
function joinLinesLikeCodeMirror(text: string): string {
	return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text
}

function noopDirtyChange(): void {
	// Default for every read-only caller — CodeMirrorSource always calls onDirtyChange, so a real
	// no-op keeps that call unconditional rather than every render site branching on whether a
	// callback was even passed. Applied in the body: the React Compiler skips a component with
	// parameter defaults, and its unmemoized `extensions` would reconfigure CodeMirror on every render.
}

// The actual CodeMirror surface. `text` seeds the editor ONCE, at mount (useState's initial argument is
// only ever consumed on the first render) — the EDITOR INVARIANT: a genuinely different piece of
// content (a different file, a different note) must remount this component (key by its identity) —
// that is the ONLY path that may ever reseed it; nothing in here ever re-derives the buffer from a
// later `text` prop change, so a re-render from an unrelated cause (theme flip, language chunk
// landing) can never clobber in-progress edits or echo-loop.
export function CodeMirrorSource({
	text,
	tag,
	alt,
	editable: editableProp,
	onDirtyChange: onDirtyChangeProp,
	contentRef,
	onValueChange,
	autoFocus,
	locked
}: CodeMirrorSourceProps) {
	const editable = editableProp ?? false
	const onDirtyChange = onDirtyChangeProp ?? noopDirtyChange
	const codeMirrorTheme = useCodeMirrorTheme()
	const languageExtension = useLanguageExtension(tag)
	// Find, replace and (in markdown) formatting, on the user's own shortcuts.
	const editorKeymap = useEditorKeymap(tag === "markdown")
	const [lock] = useState(emptyCompartment)
	// Holds the change listener, installed once the view exists (handleCreateEditor).
	const [changes] = useState(emptyCompartment)
	const editorRef = useRef<ReactCodeMirrorRef>(null)
	// The view as handed over at creation: the imperative handle only catches up a commit later.
	const viewRef = useRef<EditorView | null>(null)
	const [seed] = useState(() => joinLinesLikeCodeMirror(text))
	const [dirty, setDirty] = useState(false)
	// Latest sinks for the change listener, which is installed once: a new callback identity must never
	// reconfigure the editor.
	const sinksRef = useRef({ editable, contentRef, onValueChange })

	useEffect(() => {
		sinksRef.current = { editable, contentRef, onValueChange }
	})

	const extensions = languageExtension
		? [languageExtension, EditorView.lineWrapping, editorKeymap, lock.initial, changes.initial]
		: [EditorView.lineWrapping, editorKeymap, lock.initial, changes.initial]
	const isLocked = locked === true

	// A lock change on the live view; a view created while locked takes it in handleCreateEditor.
	useEffect(() => {
		editorRef.current?.view?.dispatch({ effects: lock.compartment.reconfigure(isLocked ? LOCKED : []) })
	}, [lock, isLocked])

	function handleCreateEditor(view: EditorView): void {
		// Dirty compares against the doc the view was created with, in the editor's own structure, so
		// deciding it never flattens a large document into a string on each keystroke.
		const seedDoc = view.state.doc

		viewRef.current = view

		function readBuffer(): string {
			return view.state.doc.toString()
		}

		const listener = EditorView.updateListener.of(update => {
			const sinks = sinksRef.current

			// @uiw's own value sync is not an edit (its onChange skips it the same way).
			if (
				!update.docChanged ||
				!sinks.editable ||
				update.transactions.some(transaction => transaction.annotation(ExternalChange) === true)
			) {
				return
			}

			setDirty(!update.state.doc.eq(seedDoc))

			// Re-armed on every edit: the overlay nulls it on a slot change, which can land after this
			// editor's own mount effect when its bytes were already cached.
			if (sinks.contentRef) {
				sinks.contentRef.current = readBuffer
			}

			// Only a caller that consumes every change pays for the string.
			sinks.onValueChange?.(update.state.doc.toString())
		})

		view.dispatch({
			effects: isLocked
				? [changes.compartment.reconfigure(listener), lock.compartment.reconfigure(LOCKED)]
				: changes.compartment.reconfigure(listener)
		})
	}

	useEffect(() => {
		onDirtyChange(dirty)
	}, [dirty, onDirtyChange])

	// Before the view exists the buffer is still the seed.
	useEffect(() => {
		if (contentRef) {
			contentRef.current = editable ? () => viewRef.current?.state.doc.toString() ?? seed : null
		}
	}, [contentRef, editable, seed])

	return (
		<div className="size-full">
			<CodeMirror
				// @uiw's own wrapper div (the one this className lands on) has no height of its own — the
				// `height="100%"` prop below only reaches `.cm-editor`/`.cm-scroller` INSIDE that wrapper, so
				// without this the wrapper collapses to content height and everything past the fold is
				// unreachable. The parent `size-full` div above must already be height-bounded by the caller.
				ref={editorRef}
				className="size-full"
				// The seed, never the live buffer: the view's doc is the buffer of record. A changing value is
				// written back into the doc, and one committed mid-typing is held until typing pauses and then
				// written over whatever was typed since. No onChange either: @uiw would flatten the whole doc
				// into a string on every change for it.
				value={seed}
				extensions={extensions}
				editable={editable}
				readOnly={!editable}
				theme={codeMirrorTheme}
				// Its Mod-f would shadow a rebound editor.find; useEditorKeymap carries the rest of it.
				basicSetup={BASIC_SETUP}
				height="100%"
				aria-label={alt}
				autoFocus={autoFocus ?? false}
				onCreateEditor={handleCreateEditor}
			/>
		</div>
	)
}
