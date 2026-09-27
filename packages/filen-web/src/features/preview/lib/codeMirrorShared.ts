import { useEffect, useState } from "react"
import { oneDarkHighlightStyle } from "@uiw/react-codemirror"
import { EditorView, keymap, type Command, type KeyBinding } from "@codemirror/view"
import { Prec, type Extension } from "@codemirror/state"
import { openSearchPanel, searchKeymap } from "@codemirror/search"
import { useComboFor } from "@/lib/keymap/registry"
import { codeMirrorKeys } from "@/features/preview/lib/editorKeys.logic"
import { insertLink, MARKDOWN_MARKERS, toggleInlineMarker } from "@/features/preview/lib/markdownCommands"
import { StreamLanguage, syntaxHighlighting } from "@codemirror/language"
import { useTheme } from "@/providers/themeProvider"

// The language and theme plumbing every CodeMirror surface shares: the editor/reader
// (codeMirrorSource.tsx) and the remote-change comparison (remoteCompare.tsx).

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
export function useLanguageExtension(tag: string): Extension | null {
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

// The editor chrome reads the app's color tokens, so it follows the palette in both themes; only
// the syntax colors differ per theme (the bundled dark theme would also paint its own background).
const TOKEN_CHROME = EditorView.theme({
	"&": { backgroundColor: "transparent", color: "var(--foreground)" },
	".cm-gutters": { backgroundColor: "transparent", color: "var(--muted-foreground)", border: "none" },
	".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--muted)" },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
		backgroundColor: "color-mix(in oklab, var(--foreground) 18%, transparent)"
	},
	// The find/replace panel (editor.find, editor.replace), in the app's controls rather than the
	// browser-default ones CodeMirror ships.
	".cm-panels": { backgroundColor: "var(--background)", color: "var(--foreground)" },
	".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
	".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
	".cm-search": { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", padding: "8px 36px 8px 12px", fontSize: "13px" },
	".cm-search br": { flexBasis: "100%", height: "0" },
	".cm-textfield": {
		height: "28px",
		margin: "0",
		padding: "0 8px",
		fontSize: "13px",
		color: "var(--foreground)",
		backgroundColor: "transparent",
		border: "1px solid var(--input)",
		borderRadius: "8px",
		outline: "none"
	},
	".cm-textfield:focus": { borderColor: "var(--ring)", boxShadow: "0 0 0 2px color-mix(in oklab, var(--ring) 35%, transparent)" },
	".cm-button": {
		height: "28px",
		margin: "0",
		padding: "0 10px",
		fontSize: "13px",
		color: "var(--secondary-foreground)",
		backgroundImage: "none",
		backgroundColor: "var(--secondary)",
		border: "none",
		borderRadius: "8px",
		cursor: "pointer"
	},
	".cm-button:hover": { backgroundColor: "color-mix(in oklab, var(--secondary) 80%, var(--foreground))" },
	".cm-search label": { display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--muted-foreground)", fontSize: "13px" },
	".cm-search button[name=close]": {
		top: "50%",
		right: "10px",
		transform: "translateY(-50%)",
		fontSize: "18px",
		color: "var(--muted-foreground)",
		cursor: "pointer"
	},
	".cm-searchMatch": { backgroundColor: "color-mix(in oklab, #facc15 35%, transparent)", outline: "none" },
	".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in oklab, #f97316 45%, transparent)" }
})

const LIGHT_THEME: Extension = [TOKEN_CHROME]
const DARK_THEME: Extension = [TOKEN_CHROME, syntaxHighlighting(oneDarkHighlightStyle)]

// The theme extension for the app's current light/dark mode. "system" resolves once per render against
// the live media query — cheap, and consistent with this being a low-stakes styling read rather than a
// value anything else depends on.
export function useCodeMirrorTheme(): Extension {
	const { theme } = useTheme()
	const resolved = theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme

	return resolved === "dark" ? DARK_THEME : LIGHT_THEME
}

// The search panel with its replace field focused; a read-only editor's panel has none and keeps the
// search field.
const openReplacePanel: Command = view => {
	openSearchPanel(view)

	const replaceField = view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")

	replaceField?.focus()
	replaceField?.select()

	return true
}

// CodeMirror's own search bindings but its Mod-f, which editor.find rebinds (basicSetup's copy is
// switched off where this is used).
const SEARCH_BINDINGS: readonly KeyBinding[] = searchKeymap.filter(binding => binding.key !== "Mod-f")

// The editor shortcuts (features/preview/lib/keymap.ts), bound inside CodeMirror so they act on the
// focused editor only, and follow whatever the user rebound them to. The markdown ones only in a markdown
// editor.
export function useEditorKeymap(markdown: boolean): Extension {
	const find = useComboFor("editor.find")
	const replace = useComboFor("editor.replace")
	const bold = useComboFor("editor.bold")
	const italic = useComboFor("editor.italic")
	const strikethrough = useComboFor("editor.strikethrough")
	const code = useComboFor("editor.code")
	const link = useComboFor("editor.link")
	const bindings: KeyBinding[] = []

	function bind(combo: string, run: Command): void {
		for (const key of codeMirrorKeys(combo)) {
			bindings.push({ key, run })
		}
	}

	bind(find, openSearchPanel)
	bind(replace, openReplacePanel)

	if (markdown) {
		bind(bold, toggleInlineMarker(MARKDOWN_MARKERS.bold))
		bind(italic, toggleInlineMarker(MARKDOWN_MARKERS.italic))
		bind(strikethrough, toggleInlineMarker(MARKDOWN_MARKERS.strikethrough))
		bind(code, toggleInlineMarker(MARKDOWN_MARKERS.code))
		bind(link, insertLink)
	}

	bindings.push(...SEARCH_BINDINGS)

	return Prec.high(keymap.of(bindings))
}
