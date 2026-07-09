import { useEffect, useState } from "react"
import CodeMirror from "@uiw/react-codemirror"
import { EditorView } from "@codemirror/view"
import { type Extension } from "@codemirror/state"
import { StreamLanguage } from "@codemirror/language"
import { asDirectoryOrFile, type DriveItem } from "@/lib/drive/item"
import { extensionOf, codeMirrorLanguageFor, decodeUtf8 } from "@/lib/drive/preview.logic"
import { usePreviewBytes } from "@/components/preview/use-preview-bytes"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useTheme } from "@/components/theme-provider"
import { Spinner } from "@/components/ui/spinner"

export interface TextViewerProps {
	item: DriveItem
	alt: string
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

// The actual CodeMirror surface, once bytes are decoded — split from TextViewer below so the
// pending/error states above it never mount a CodeMirror instance (and never trigger a language chunk
// fetch) in the first place.
function TextSource({ text, tag, alt }: { text: string; tag: string; alt: string }) {
	const { theme } = useTheme()
	// "system" resolves once per render against the live media query — cheap, and consistent with this
	// being a low-stakes styling read rather than a value anything else depends on; a live OS-theme flip
	// while a preview happens to be open repaints on this component's next render, same ceiling the
	// app's own ThemeProvider effect already has for any consumer that isn't sonner's own bundled
	// System-aware Toaster.
	const resolvedTheme = theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme
	const languageExtension = useLanguageExtension(tag)
	const extensions = languageExtension ? [languageExtension, EditorView.lineWrapping] : [EditorView.lineWrapping]

	return (
		<div className="size-full">
			<CodeMirror
				value={text}
				extensions={extensions}
				editable={false}
				readOnly
				theme={resolvedTheme}
				height="100%"
				aria-label={alt}
			/>
		</div>
	)
}

// Top-level gate on the whole-buffer download (usePreviewBytes, shared with every other buffered
// category), then a non-fatal UTF-8 decode (decodeUtf8 — never throws) and a per-extension language
// lookup. Read-only ONLY for now: `editable`/`readOnly` above are hard-set, not parameterized, so this
// stays the fully-inert preview surface for text/code. The next task threads an `editable` prop through
// to make this the same component's writable mode (frozen-seed/remount, its own concern) rather than a
// rewrite — TextSource's props (text/tag/alt) don't change shape either way.
function TextViewer({ item, alt }: TextViewerProps) {
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
		/>
	)
}

export default TextViewer
