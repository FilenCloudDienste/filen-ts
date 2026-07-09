import { useEffect, useState, type RefObject } from "react"
import CodeMirror from "@uiw/react-codemirror"
import { EditorView } from "@codemirror/view"
import { type Extension } from "@codemirror/state"
import { StreamLanguage } from "@codemirror/language"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { extensionOf, codeMirrorLanguageFor, decodeUtf8 } from "@/features/drive/lib/preview.logic"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useTheme } from "@/providers/themeProvider"
import { Spinner } from "@/components/ui/spinner"

export interface TextViewerProps {
	item: DriveItem
	alt: string
	// Writable mode for the preview-save feature — omitted (or false) by every read-only caller
	// (markdown-viewer.tsx's own view-source toggle never edits its source), so those call sites need
	// no changes. `onDirtyChange`/`contentRef` are only ever read while `editable` is true.
	editable?: boolean
	// Fired whenever the dirty bit flips (never on every keystroke) — the overlay mirrors it into its
	// own state to gate the Save button/Cmd+S/close+nav confirm, none of which this component renders
	// itself (the header lives in preview-overlay.tsx).
	onDirtyChange?: (dirty: boolean) => void
	// Write-only side channel for the overlay's Save handler to read the CURRENT buffer on demand
	// (Cmd+S/button click) without this component re-rendering the overlay on every keystroke — a
	// plain reactive callback would force that; a ref lets the overlay pull, not push. Kept up to date
	// from an effect (never during render — refs are an event-handler/effect-only escape hatch).
	contentRef?: RefObject<string | null>
}

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
// with no wired grammar ("" or an unmapped one — the file still renders, just unhighlighted). The
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
				// unhighlighted plain text via the stale-guard below — never blocks the file's own
				// content, which is already decoded and rendering.
			})

		return () => {
			live = false
		}
	}, [tag])

	return loaded?.tag === tag ? loaded.extension : null
}

interface TextSourceProps {
	text: string
	tag: string
	alt: string
	editable: boolean
	onDirtyChange: (dirty: boolean) => void
	contentRef: RefObject<string | null> | undefined
}

// The actual CodeMirror surface, once bytes are decoded — split from TextViewer below so the
// pending/error states above it never mount a CodeMirror instance (and never trigger a language chunk
// fetch) in the first place. `text` seeds `content` ONCE, at mount (useState's initial argument is
// only ever consumed on the first render) — the EDITOR INVARIANT: this component is remounted fresh
// per item (preview-overlay.tsx keys the whole preview body by item uuid), which is the ONLY path that
// may ever reseed it; nothing in here ever re-derives `content` from a later `text` prop change, so a
// re-render from an unrelated cause (theme flip, language chunk landing) can never clobber in-progress
// edits or echo-loop.
function TextSource({ text, tag, alt, editable, onDirtyChange, contentRef }: TextSourceProps) {
	const { theme } = useTheme()
	// "system" resolves once per render against the live media query — cheap, and consistent with this
	// being a low-stakes styling read rather than a value anything else depends on; a live OS-theme flip
	// while a preview happens to be open repaints on this component's next render, same ceiling the
	// app's own ThemeProvider effect already has for any consumer that isn't sonner's own bundled
	// System-aware Toaster.
	const resolvedTheme = theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme
	const languageExtension = useLanguageExtension(tag)
	const extensions = languageExtension ? [languageExtension, EditorView.lineWrapping] : [EditorView.lineWrapping]
	const [content, setContent] = useState(text)
	// `text` itself never changes across this component's own lifetime (a genuinely different item
	// forces a remount, not a prop update — see the invariant above), so comparing against it directly
	// doubles as "compare against the frozen original" with no extra ref of its own. Unconditional — no
	// `editable &&` guard: `content` can only ever diverge from `text` through `onChange` below, which
	// itself requires `editable`, so this is a no-op for an always-read-only mount, and, unlike a guarded
	// version, SURVIVES a later editable->false flip (a failed save's read-only lock, preview-overlay.tsx)
	// instead of masking genuinely unsaved edits as clean.
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
				// Always the live buffer, never `text` directly — `content` only diverges from it through
				// `onChange` below (itself editable-gated), so this is a no-op for an always-read-only
				// mount, and, for one whose `editable` flips false mid-session (a failed save's read-only
				// lock, preview-overlay.tsx), keeps the user's typed edits ON SCREEN instead of visibly
				// reverting them to the pre-edit original.
				value={content}
				extensions={extensions}
				editable={editable}
				readOnly={!editable}
				theme={resolvedTheme}
				height="100%"
				aria-label={alt}
				// exactOptionalPropertyTypes rejects an explicit onChange={undefined} (the prop's own type
				// has no `| undefined` arm) — omit the key entirely in read-only mode instead.
				{...(editable ? { onChange: setContent } : {})}
			/>
		</div>
	)
}

function noopDirtyChange(): void {
	// Default for every read-only caller (this component's own default, and markdown-viewer.tsx's
	// view-source toggle) — TextSource always calls onDirtyChange, so a real no-op keeps that call
	// unconditional rather than every render site branching on whether a callback was even passed.
}

// Top-level gate on the whole-buffer download (usePreviewBytes, shared with every other buffered
// category), then a non-fatal UTF-8 decode (decodeUtf8 — never throws) and a per-extension language
// lookup.
function TextViewer({ item, alt, editable = false, onDirtyChange = noopDirtyChange, contentRef }: TextViewerProps) {
	const result = usePreviewBytes(item)

	if (result.status === "pending") {
		return (
			<div className="flex size-full items-center justify-center">
				<Spinner className="size-6" />
			</div>
		)
	}

	if (result.status === "error") {
		return (
			<div className="flex size-full items-center justify-center px-6 text-center text-sm text-destructive">
				{errorLabel(result.dto)}
			</div>
		)
	}

	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return null
	}

	const name = base.data.decryptedMeta?.name ?? base.data.uuid
	const tag = codeMirrorLanguageFor(extensionOf(name))
	const text = decodeUtf8(result.bytes)

	return (
		<TextSource
			text={text}
			tag={tag}
			alt={alt}
			editable={editable}
			onDirtyChange={onDirtyChange}
			contentRef={contentRef}
		/>
	)
}

export default TextViewer
