import { oneDarkHighlightStyle } from "@uiw/react-codemirror"
import { EditorView, keymap, type Command, type KeyBinding } from "@codemirror/view"
import { Prec, type Extension } from "@codemirror/state"
import { openSearchPanel, searchKeymap } from "@codemirror/search"
import { useComboFor } from "@/lib/keymap/registry"
import { codeMirrorKeys } from "@/features/preview/lib/editorKeys.logic"
import { insertLink, MARKDOWN_MARKERS, toggleInlineMarker, toggleItalic } from "@/features/preview/lib/markdownCommands"
import { StreamLanguage, syntaxHighlighting } from "@codemirror/language"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { html } from "@codemirror/lang-html"
import { css } from "@codemirror/lang-css"
import { xml } from "@codemirror/lang-xml"
import { sql } from "@codemirror/lang-sql"
import { python } from "@codemirror/lang-python"
import { rust } from "@codemirror/lang-rust"
import { cpp } from "@codemirror/lang-cpp"
import { java } from "@codemirror/lang-java"
import { php } from "@codemirror/lang-php"
import { markdown } from "@codemirror/lang-markdown"
import { yaml } from "@codemirror/lang-yaml"
import { sass } from "@codemirror/lang-sass"
import { less } from "@codemirror/lang-less"
import { go } from "@codemirror/lang-go"
import { coffeeScript } from "@codemirror/legacy-modes/mode/coffeescript"
import { shell } from "@codemirror/legacy-modes/mode/shell"
import { ruby } from "@codemirror/legacy-modes/mode/ruby"
import { lua } from "@codemirror/legacy-modes/mode/lua"
import { toml } from "@codemirror/legacy-modes/mode/toml"
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile"
import { cmake } from "@codemirror/legacy-modes/mode/cmake"
import { swift } from "@codemirror/legacy-modes/mode/swift"
import { cobol } from "@codemirror/legacy-modes/mode/cobol"
import { vbScript } from "@codemirror/legacy-modes/mode/vbscript"
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf"
import { properties } from "@codemirror/legacy-modes/mode/properties"
import { powerShell } from "@codemirror/legacy-modes/mode/powershell"
import { groovy } from "@codemirror/legacy-modes/mode/groovy"
import { csharp, kotlin, dart } from "@codemirror/legacy-modes/mode/clike"
import { resolveTheme, useTheme } from "@/providers/themeProvider"
import type { CodeMirrorTag } from "@/features/drive/lib/preview.logic"

// The language and theme plumbing every CodeMirror surface shares: the editor/reader
// (codeMirrorSource.tsx) and the remote-change comparison (remoteCompare.tsx).

// tag -> the matching CodeMirror language Extension, built on first use. Keyed by CodeMirrorTag so tsc
// keeps the keys in step with codeMirrorLanguageFor.
const LANGUAGES: Readonly<Record<CodeMirrorTag, () => Extension>> = {
	javascript: () => javascript(),
	jsx: () => javascript({ jsx: true }),
	typescript: () => javascript({ typescript: true }),
	tsx: () => javascript({ jsx: true, typescript: true }),
	json: () => json(),
	html: () => html(),
	css: () => css(),
	xml: () => xml(),
	sql: () => sql(),
	python: () => python(),
	rust: () => rust(),
	cpp: () => cpp(),
	java: () => java(),
	php: () => php(),
	markdown: () => markdown(),
	yaml: () => yaml(),
	sass: () => sass({ indented: true }),
	less: () => less(),
	go: () => go(),
	coffeescript: () => StreamLanguage.define(coffeeScript),
	shell: () => StreamLanguage.define(shell),
	ruby: () => StreamLanguage.define(ruby),
	lua: () => StreamLanguage.define(lua),
	toml: () => StreamLanguage.define(toml),
	dockerfile: () => StreamLanguage.define(dockerFile),
	cmake: () => StreamLanguage.define(cmake),
	swift: () => StreamLanguage.define(swift),
	cobol: () => StreamLanguage.define(cobol),
	vbscript: () => StreamLanguage.define(vbScript),
	protobuf: () => StreamLanguage.define(protobuf),
	ini: () => StreamLanguage.define(properties),
	powershell: () => StreamLanguage.define(powerShell),
	groovy: () => StreamLanguage.define(groovy),
	csharp: () => StreamLanguage.define(csharp),
	kotlin: () => StreamLanguage.define(kotlin),
	dart: () => StreamLanguage.define(dart)
}

// One instance per tag for the session: a new identity would reconfigure every editor showing it.
const languageCache = new Map<string, Extension>()

// `tag` (from codeMirrorLanguageFor) as its language Extension, or null for a tag with no wired grammar
// ("" or an unmapped one: the content still renders, just unhighlighted).
export function languageExtensionFor(tag: string): Extension | null {
	const cached = languageCache.get(tag)

	if (cached !== undefined) {
		return cached
	}

	const languages: Readonly<Partial<Record<string, () => Extension>>> = LANGUAGES
	const build = languages[tag]

	if (build === undefined) {
		return null
	}

	const extension = build()

	languageCache.set(tag, extension)

	return extension
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

	return resolveTheme(theme) === "dark" ? DARK_THEME : LIGHT_THEME
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

const EDITOR_SCOPE = "editor"
const SEARCH_SCOPE = "editor search-panel"

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

	function bind(combo: string, run: Command, scope: string): void {
		for (const key of codeMirrorKeys(combo)) {
			bindings.push({ key, run, scope })
		}
	}

	// Find and replace also answer with focus in the search panel's own fields.
	bind(find, openSearchPanel, SEARCH_SCOPE)
	bind(replace, openReplacePanel, SEARCH_SCOPE)

	if (markdown) {
		bind(bold, toggleInlineMarker(MARKDOWN_MARKERS.bold), EDITOR_SCOPE)
		bind(italic, toggleItalic, EDITOR_SCOPE)
		bind(strikethrough, toggleInlineMarker(MARKDOWN_MARKERS.strikethrough), EDITOR_SCOPE)
		bind(code, toggleInlineMarker(MARKDOWN_MARKERS.code), EDITOR_SCOPE)
		bind(link, insertLink, EDITOR_SCOPE)
	}

	bindings.push(...SEARCH_BINDINGS)

	return Prec.high(keymap.of(bindings))
}
