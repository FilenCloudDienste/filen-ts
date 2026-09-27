import { useEffect, useState, type RefObject } from "react"
import CodeMirror from "@uiw/react-codemirror"
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
	// entirely (defaults to a no-op below), since `content` can only diverge from `text` via `onChange`,
	// itself editable-gated.
	onDirtyChange?: (dirty: boolean) => void
	// Write-only side channel for a Save handler to read the CURRENT buffer on demand without this
	// component re-rendering its parent on every keystroke. Kept up to date from an effect (never
	// during render — refs are an event-handler/effect-only escape hatch).
	contentRef?: RefObject<string | null>
	// Per-change callback (editable-only): fires the CURRENT buffer on EVERY change, not just the
	// dirty edge — the notes editor's immediate-persist rule enqueues on every keystroke, unlike the
	// preview save path that reads on demand via contentRef. Read-only callers omit it (never fires).
	onValueChange?: (value: string) => void
}

const BASIC_SETUP = { searchKeymap: false }

function noopDirtyChange(): void {
	// Default for every read-only caller — CodeMirrorSource always calls onDirtyChange, so a real
	// no-op keeps that call unconditional rather than every render site branching on whether a
	// callback was even passed.
}

// The actual CodeMirror surface. `text` seeds `content` ONCE, at mount (useState's initial argument is
// only ever consumed on the first render) — the EDITOR INVARIANT: a genuinely different piece of
// content (a different file, a different note) must remount this component (key by its identity) —
// that is the ONLY path that may ever reseed it; nothing in here ever re-derives `content` from a
// later `text` prop change, so a re-render from an unrelated cause (theme flip, language chunk
// landing) can never clobber in-progress edits or echo-loop.
export function CodeMirrorSource({
	text,
	tag,
	alt,
	editable = false,
	onDirtyChange = noopDirtyChange,
	contentRef,
	onValueChange
}: CodeMirrorSourceProps) {
	const codeMirrorTheme = useCodeMirrorTheme()
	const languageExtension = useLanguageExtension(tag)
	// Find, replace and (in markdown) formatting, on the user's own shortcuts.
	const editorKeymap = useEditorKeymap(tag === "markdown")
	const extensions = languageExtension
		? [languageExtension, EditorView.lineWrapping, editorKeymap]
		: [EditorView.lineWrapping, editorKeymap]
	const [content, setContent] = useState(text)
	// `text` itself never changes across this component's own lifetime (a genuinely different item
	// forces a remount, not a prop update — see the invariant above), so comparing against it directly
	// doubles as "compare against the frozen original" with no extra ref of its own.
	const dirty = content !== text

	useEffect(() => {
		onDirtyChange(dirty)
	}, [dirty, onDirtyChange])

	// Refs are an event-handler/effect-only escape hatch — never written during render — so this
	// mirrors `content` into it on every commit instead of the ref-during-render shortcut.
	useEffect(() => {
		if (contentRef) {
			contentRef.current = editable ? content : null
		}
	}, [contentRef, editable, content])

	// Editable change handler: updates the internal buffer AND forwards every change to a notes
	// caller's per-keystroke sink. Read-only mode omits onChange entirely (below), so this never runs
	// for a preview/reader mount and can never echo-loop the frozen seed.
	function handleChange(value: string): void {
		setContent(value)
		onValueChange?.(value)
	}

	return (
		<div className="size-full">
			<CodeMirror
				// @uiw's own wrapper div (the one this className lands on) has no height of its own — the
				// `height="100%"` prop below only reaches `.cm-editor`/`.cm-scroller` INSIDE that wrapper, so
				// without this the wrapper collapses to content height and everything past the fold is
				// unreachable. The parent `size-full` div above must already be height-bounded by the caller.
				className="size-full"
				value={content}
				extensions={extensions}
				editable={editable}
				readOnly={!editable}
				theme={codeMirrorTheme}
				// Its Mod-f would shadow a rebound editor.find; useEditorKeymap carries the rest of it.
				basicSetup={BASIC_SETUP}
				height="100%"
				aria-label={alt}
				// exactOptionalPropertyTypes rejects an explicit onChange={undefined} — omit the key entirely
				// in read-only mode instead.
				{...(editable ? { onChange: handleChange } : {})}
			/>
		</div>
	)
}
