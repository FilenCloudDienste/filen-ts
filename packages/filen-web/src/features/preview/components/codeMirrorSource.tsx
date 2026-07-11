import { useEffect, useState, type RefObject } from "react"
import CodeMirror from "@uiw/react-codemirror"
import { EditorView } from "@codemirror/view"
import { type Extension } from "@codemirror/state"
import { StreamLanguage } from "@codemirror/language"
import { useTheme } from "@/providers/themeProvider"

// Shared CodeMirror read/write surface — extracted from textViewer.tsx so the notes reader (and, next
// wave, the notes editor) reuses the SAME language-loader/theme plumbing as file preview rather than a
// second copy. Preview's own textViewer.tsx is this module's regression net (its e2e/unit coverage did
// not change shape, only its import path did).

// tag -> a loader for the matching CodeMirror language Extension, one dynamic import() per entry so
// each grammar (and, for the legacy StreamParser ones, its own @codemirror/legacy-modes/mode/* submodule)
// becomes its own chunk — opening one text file only ever fetches the ONE language it actually needs,
// never the other ~35. @codemirror/language itself (StreamLanguage) is a static import above: it's
// core CodeMirror machinery every language needs, not a per-language grammar, so splitting it out would
// buy nothing. Keys mirror preview.logic.ts's codeMirrorLanguageFor tags exactly.
const LANGUAGE_LOADERS: Readonly<Record<string, () => Promise<Extension>>> = {
	javascript: async () => (await import("@codemirror/lang-javascript")).javascript(),
	jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
	typescript: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
	tsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }),
	json: async () => (await import("@codemirror/lang-json")).json(),
	html: async () => (await import("@codemirror/lang-html")).html(),
	css: async () => (await import("@codemirror/lang-css")).css(),
	xml: async () => (await import("@codemirror/lang-xml")).xml(),
	sql: async () => (await import("@codemirror/lang-sql")).sql(),
	python: async () => (await import("@codemirror/lang-python")).python(),
	rust: async () => (await import("@codemirror/lang-rust")).rust(),
	cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
	java: async () => (await import("@codemirror/lang-java")).java(),
	php: async () => (await import("@codemirror/lang-php")).php(),
	markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
	yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
	sass: async () => (await import("@codemirror/lang-sass")).sass({ indented: true }),
	less: async () => (await import("@codemirror/lang-less")).less(),
	go: async () => (await import("@codemirror/lang-go")).go(),
	coffeescript: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/coffeescript")).coffeeScript),
	shell: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell),
	ruby: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/ruby")).ruby),
	lua: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/lua")).lua),
	toml: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml),
	dockerfile: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile),
	cmake: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/cmake")).cmake),
	swift: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/swift")).swift),
	cobol: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/cobol")).cobol),
	vbscript: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/vbscript")).vbScript),
	protobuf: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/protobuf")).protobuf),
	ini: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/properties")).properties),
	powershell: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
	groovy: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/groovy")).groovy),
	csharp: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).csharp),
	kotlin: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).kotlin),
	dart: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).dart)
}

// Resolves `tag` (from codeMirrorLanguageFor) to a loaded Extension, or null while pending / for a tag
// with no wired grammar ("" or an unmapped one — the content still renders, just unhighlighted). The
// `loaded.tag === tag` guard is a render-time derivation, not a second effect: it discards a
// still-resolving or already-resolved extension from a PREVIOUS tag rather than flashing stale
// highlighting, with no extra commit for what both branches ultimately return synchronously anyway.
function useLanguageExtension(tag: string): Extension | null {
	const [loaded, setLoaded] = useState<{ tag: string; extension: Extension } | null>(null)

	useEffect(() => {
		const loader = LANGUAGE_LOADERS[tag]

		if (!loader) {
			return undefined
		}

		let live = true

		loader()
			.then(extension => {
				if (live) {
					setLoaded({ tag, extension })
				}
			})
			.catch(() => {
				// A language chunk failing to fetch (offline mid-load, CDN hiccup) degrades to
				// unhighlighted plain text via the stale-guard below — never blocks the content, which
				// is already decoded and rendering.
			})

		return () => {
			live = false
		}
	}, [tag])

	return loaded?.tag === tag ? loaded.extension : null
}

export interface CodeMirrorSourceProps {
	text: string
	tag: string
	alt: string
	// Writable mode for the preview-save feature — omitted (or false) by every read-only caller (the
	// notes reader, markdownViewer.tsx's own view-source toggle) so those need no changes.
	editable?: boolean
	// Fired whenever the dirty bit flips (never on every keystroke) — a read-only caller can omit this
	// entirely (defaults to a no-op below), since `content` can only diverge from `text` via `onChange`,
	// itself editable-gated.
	onDirtyChange?: (dirty: boolean) => void
	// Write-only side channel for a Save handler to read the CURRENT buffer on demand without this
	// component re-rendering its parent on every keystroke. Kept up to date from an effect (never
	// during render — refs are an event-handler/effect-only escape hatch).
	contentRef?: RefObject<string | null>
}

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
export function CodeMirrorSource({ text, tag, alt, editable = false, onDirtyChange = noopDirtyChange, contentRef }: CodeMirrorSourceProps) {
	const { theme } = useTheme()
	// "system" resolves once per render against the live media query — cheap, and consistent with this
	// being a low-stakes styling read rather than a value anything else depends on.
	const resolvedTheme = theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme
	const languageExtension = useLanguageExtension(tag)
	const extensions = languageExtension ? [languageExtension, EditorView.lineWrapping] : [EditorView.lineWrapping]
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
				theme={resolvedTheme}
				height="100%"
				aria-label={alt}
				// exactOptionalPropertyTypes rejects an explicit onChange={undefined} — omit the key entirely
				// in read-only mode instead.
				{...(editable ? { onChange: setContent } : {})}
			/>
		</div>
	)
}
