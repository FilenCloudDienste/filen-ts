import { useEffect, useRef, useState, type RefObject } from "react"
import { Compartment, Text, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { codeEditorSetup, codeFillParent, codeReadOnly, codeTheme } from "@filen/office/dom/code"
import { CodeEditor } from "@filen/office/react/code"
import { languageExtensionFor, useEditorKeymap, type EditorKeymapCommands } from "@/features/preview/lib/codeMirrorShared"
import type { Unencodable } from "@filen/shared/textEncoding"
import { encodeTextFile, lineBreak, writeTextFile, type TextBuffer, type TextFileFormat } from "@/features/preview/lib/textFile"
import { lineBreaksField, otherLineBreaks, type LineBreaks } from "@/features/preview/lib/lineBreaks"

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
	// re-rendering its parent on every keystroke: a reader, so the doc is flattened into a string (or bytes) only
	// when someone asks, never per keystroke. Null while not editable. Still answers with the last buffer
	// after unmount (a destroyed view keeps its final state).
	contentRef?: RefObject<TextBuffer | null>
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
	// The file's encoding, byte order mark and line ending, put back in what contentRef reads (textFile.ts). May
	// change while mounted (a conversion to UTF-8).
	format?: TextFileFormat
	// A save writes something else than the file even with no edit (a conversion): dirty from the start.
	changed?: boolean
	// contentRef's bytes() met a character the format's encoding cannot hold.
	onUnencodable?: (at: Unencodable) => void
	// The view once created, null once gone, for a host that reads or edits it from outside (the assistant's selection
	// transform). Unlike `chrome`, it leaves the editor's own wrapping, line numbers and keys alone. Stable for the
	// editor's life.
	onView?: (view: EditorView | null) => void
	// A markdown editor's live preview (lib/livePreview), or null for its plain source. Switched on the live view in a
	// compartment of its own: the buffer, selection and history carry on.
	livePreview?: Extension | null
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

// The buffer as contentRef hands it out, in the format current when it is read; `breaks`: the line breaks the file
// keeps other than its own ending (none without a format).
function textBuffer(
	read: () => { doc: Text; breaks: LineBreaks | undefined },
	sinksRef: RefObject<{ format: TextFileFormat | undefined; onUnencodable: ((at: Unencodable) => void) | undefined }>
): TextBuffer {
	return {
		text() {
			const format = sinksRef.current.format
			const { doc, breaks } = read()

			return format === undefined ? doc.toString() : writeTextFile(doc, format, breaks)
		},
		bytes() {
			const format = sinksRef.current.format
			const { doc, breaks } = read()

			return format === undefined ? { bytes: new TextEncoder().encode(doc.toString()) } : encodeTextFile(doc, format, breaks)
		},
		explain(at) {
			sinksRef.current.onUnencodable?.(at)
		}
	}
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
	format,
	changed: changedProp,
	onUnencodable,
	onView,
	livePreview
}: CodeMirrorSourceProps) {
	const changed = changedProp === true
	const editable = editableProp ?? false
	const onDirtyChange = onDirtyChangeProp ?? noopDirtyChange
	const languageExtension = languageExtensionFor(tag)
	// Find, replace and (in markdown) formatting, on the user's own shortcuts.
	const editorKeymap = useEditorKeymap(tag === "markdown", chrome?.keymap)
	const [lock] = useState(emptyCompartment)
	const [live] = useState(emptyCompartment)
	// Holds the change listener, installed once the view exists (handleCreateEditor).
	const [changes] = useState(emptyCompartment)
	const viewRef = useRef<EditorView | null>(null)
	const [seed] = useState(text)
	// The file's line breaks other than its own ending, mapped through every edit so a save keeps them (lineBreaks.ts).
	const [breaks] = useState(() => (format === undefined ? null : lineBreaksField(otherLineBreaks(seed, lineBreak(format.lineEnding)))))
	// The doc the view was created with, which dirty compares against.
	const seedDocRef = useRef<Text | null>(null)
	// Reported from the change listener itself, in the same task as the edit: a state round trip would leave the
	// overlay clean for a moment, in which a key that drops the editor (the markdown view toggle) drops the edit too.
	const dirtyRef = useRef(false)
	// Latest sinks for the change listener, which is installed once: a new callback identity must never
	// reconfigure the editor.
	const sinksRef = useRef({ editable, contentRef, onValueChange, format, onDirtyChange, changed, onUnencodable })

	useEffect(() => {
		sinksRef.current = { editable, contentRef, onValueChange, format, onDirtyChange, changed, onUnencodable }
	})

	const readOnly = codeReadOnly(!editable)
	const breaksExtension = breaks?.extension ?? []
	const extensions = chrome
		? [
				codeFillParent,
				SETUP_WITHOUT_LINE_NUMBERS,
				codeTheme,
				readOnly,
				chrome.extensions,
				editorKeymap,
				lock.initial,
				live.initial,
				changes.initial,
				breaksExtension
			]
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
					live.initial,
					changes.initial,
					breaksExtension
				]
			: [
					codeFillParent,
					SETUP,
					codeTheme,
					readOnly,
					EditorView.lineWrapping,
					editorKeymap,
					lock.initial,
					live.initial,
					changes.initial,
					breaksExtension
				]
	const isLocked = locked === true

	// A lock change on the live view; a view created while locked takes it in handleCreateEditor.
	useEffect(() => {
		viewRef.current?.dispatch({ effects: lock.compartment.reconfigure(isLocked ? LOCKED : []) })
	}, [lock, isLocked])

	const liveExtension = livePreview ?? null

	// Live preview on or off (or rebuilt) on the live view; a view created with it takes it in handleCreateEditor.
	useEffect(() => {
		viewRef.current?.dispatch({ effects: live.compartment.reconfigure(liveExtension ?? []) })
	}, [live, liveExtension])

	function handleCreateEditor(view: EditorView): void {
		// Dirty compares against the doc the view was created with, in the editor's own structure, so
		// deciding it never flattens a large document into a string on each keystroke.
		const seedDoc = view.state.doc

		seedDocRef.current = seedDoc
		viewRef.current = view
		chrome?.attach(view)
		onView?.(view)

		const buffer = textBuffer(
			() => ({ doc: view.state.doc, breaks: breaks === null ? undefined : view.state.field(breaks.field) }),
			sinksRef
		)

		const listener = EditorView.updateListener.of(update => {
			const sinks = sinksRef.current

			if (!update.docChanged || !sinks.editable) {
				return
			}

			const dirty = sinks.changed || !update.state.doc.eq(seedDoc)

			if (dirty !== dirtyRef.current) {
				dirtyRef.current = dirty
				sinks.onDirtyChange(dirty)
			}

			// Re-armed on every edit: the overlay nulls it on a slot change, which can land after this
			// editor's own mount effect when its bytes were already cached.
			if (sinks.contentRef) {
				sinks.contentRef.current = buffer
			}

			// Only a caller that consumes every change pays for the string.
			sinks.onValueChange?.(update.state.doc.toString())
		})

		view.dispatch({
			effects: [
				changes.compartment.reconfigure(listener),
				...(isLocked ? [lock.compartment.reconfigure(LOCKED)] : []),
				...(liveExtension === null ? [] : [live.compartment.reconfigure(liveExtension)])
			]
		})
	}

	useEffect(() => {
		onDirtyChange(dirtyRef.current)
	}, [onDirtyChange])

	// A conversion makes the buffer differ from the file without an edit (and undoing every edit keeps it so).
	useEffect(() => {
		const doc = viewRef.current?.state.doc
		const seedDoc = seedDocRef.current
		const dirty = changed || (doc !== undefined && seedDoc !== null && !doc.eq(seedDoc))

		if (dirty !== dirtyRef.current) {
			dirtyRef.current = dirty
			sinksRef.current.onDirtyChange(dirty)
		}
	}, [changed])

	useEffect(() => {
		return () => {
			chrome?.attach(null)
		}
	}, [chrome])

	useEffect(() => {
		return () => {
			onView?.(null)
		}
	}, [onView])

	// Before the view exists the buffer is still the seed.
	useEffect(() => {
		if (contentRef) {
			contentRef.current = editable
				? textBuffer(() => {
						const state = viewRef.current?.state

						if (state === undefined) {
							return { doc: Text.of(seed.split(/\r\n?|\n/)), breaks: breaks?.initial }
						}

						return { doc: state.doc, breaks: breaks === null ? undefined : state.field(breaks.field) }
					}, sinksRef)
				: null
		}
	}, [contentRef, editable, seed, breaks])

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
