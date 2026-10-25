import { useEffect, useRef, useState, type RefObject } from "react"
import { Compartment, Text, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { codeEditorSetup, codeFillParent, codeReadOnly, codeTheme } from "@filen/office/dom/code"
import { CodeEditor } from "@filen/office/react/code"
import { languageExtensionFor, useEditorKeymap, type EditorKeymapCommands } from "@/features/preview/lib/codeMirrorShared"
import { writeTextFile, type TextFileFormat } from "@/features/preview/lib/textFile"

// Shared CodeMirror read/write surface — extracted from textViewer.tsx so the notes reader (and the
// notes editor) reuses the SAME language/theme plumbing (lib/codeMirrorShared.ts) as file preview
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
	// A host's command bar (CodeChrome): its extensions take the place of the editor's own wrapping, line numbers
	// and language, its keymap that of the search panel. Stable for the editor's life.
	chrome?: CodeMirrorChrome
	// The file's byte order mark and line ending, put back in what contentRef reads (textFile.ts).
	format?: TextFileFormat
}

export interface CodeMirrorChrome {
	readonly extensions: Extension
	readonly keymap: EditorKeymapCommands
	// The view once created, null once gone.
	attach(view: EditorView | null): void
}

const LOCKED: Extension = codeReadOnly(true)

// Its own compartment, swapped alone: the editable/readOnly props would rebuild the whole configuration.
// Compartment contents survive the wrapper's own full reconfigures (theme, language).
function emptyCompartment(): { compartment: Compartment; initial: Extension } {
	const compartment = new Compartment()

	return { compartment, initial: compartment.of([]) }
}

// Extension values hold no state of their own, so every editor shares one setup.
const SETUP: Extension = codeEditorSetup()
const SETUP_WITHOUT_LINE_NUMBERS: Extension = codeEditorSetup({ lineNumbers: false })

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
// later `text` prop change, so a re-render from an unrelated cause (theme flip, shortcut rebind) can
// never clobber in-progress edits or echo-loop.
export function CodeMirrorSource({
	text,
	tag,
	alt,
	editable: editableProp,
	onDirtyChange: onDirtyChangeProp,
	contentRef,
	onValueChange,
	autoFocus,
	locked,
	chrome,
	format
}: CodeMirrorSourceProps) {
	const editable = editableProp ?? false
	const onDirtyChange = onDirtyChangeProp ?? noopDirtyChange
	const languageExtension = languageExtensionFor(tag)
	// Find, replace and (in markdown) formatting, on the user's own shortcuts.
	const editorKeymap = useEditorKeymap(tag === "markdown", chrome?.keymap)
	const [lock] = useState(emptyCompartment)
	// Holds the change listener, installed once the view exists (handleCreateEditor).
	const [changes] = useState(emptyCompartment)
	const viewRef = useRef<EditorView | null>(null)
	const [seed] = useState(text)
	const [dirty, setDirty] = useState(false)
	// Latest sinks for the change listener, which is installed once: a new callback identity must never
	// reconfigure the editor.
	const sinksRef = useRef({ editable, contentRef, onValueChange, format })

	useEffect(() => {
		sinksRef.current = { editable, contentRef, onValueChange, format }
	})

	const readOnly = codeReadOnly(!editable)
	const extensions = chrome
		? [codeFillParent, SETUP_WITHOUT_LINE_NUMBERS, codeTheme, readOnly, chrome.extensions, editorKeymap, lock.initial, changes.initial]
		: languageExtension
			? [
					codeFillParent,
					SETUP,
					codeTheme,
					readOnly,
					languageExtension,
					EditorView.lineWrapping,
					editorKeymap,
					lock.initial,
					changes.initial
				]
			: [codeFillParent, SETUP, codeTheme, readOnly, EditorView.lineWrapping, editorKeymap, lock.initial, changes.initial]
	const isLocked = locked === true

	// A lock change on the live view; a view created while locked takes it in handleCreateEditor.
	useEffect(() => {
		viewRef.current?.dispatch({ effects: lock.compartment.reconfigure(isLocked ? LOCKED : []) })
	}, [lock, isLocked])

	function handleCreateEditor(view: EditorView): void {
		// Dirty compares against the doc the view was created with, in the editor's own structure, so
		// deciding it never flattens a large document into a string on each keystroke.
		const seedDoc = view.state.doc

		viewRef.current = view
		chrome?.attach(view)

		function readBuffer(): string {
			const fileFormat = sinksRef.current.format

			return fileFormat === undefined ? view.state.doc.toString() : writeTextFile(view.state.doc, fileFormat)
		}

		const listener = EditorView.updateListener.of(update => {
			const sinks = sinksRef.current

			if (!update.docChanged || !sinks.editable) {
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

	useEffect(() => {
		return () => {
			chrome?.attach(null)
		}
	}, [chrome])

	// Before the view exists the buffer is still the seed.
	useEffect(() => {
		if (contentRef) {
			contentRef.current = editable
				? () => {
						const doc = viewRef.current?.state.doc

						if (format === undefined) {
							return doc?.toString() ?? seed
						}

						return writeTextFile(doc ?? Text.of(seed.split(/\r\n?|\n/)), format)
					}
				: null
		}
	}, [contentRef, editable, seed, format])

	return (
		<div className="size-full">
			<CodeEditor
				// The parent `size-full` div must already be height-bounded by the caller; the editor fills it.
				className="size-full"
				// The seed, read once: the view's doc is the buffer of record. No change callback either: a
				// string of the whole doc is built only for a caller that reads it.
				doc={seed}
				extensions={extensions}
				label={alt}
				autoFocus={autoFocus ?? false}
				onCreate={handleCreateEditor}
			/>
		</div>
	)
}
