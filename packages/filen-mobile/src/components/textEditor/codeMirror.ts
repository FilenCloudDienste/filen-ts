import { langs, langNames } from "@uiw/codemirror-extensions-langs"
import { tags as t } from "@lezer/highlight"
import { createTheme } from "@uiw/codemirror-themes"
import type { Platform } from "react-native"

// No eager "preload every language" pass here on purpose. The upstream loadLanguage is a plain
// `langs[name]?.()` lookup — it registers nothing, so its return value is the only thing it
// produces and dropping it on the floor achieved exactly nothing. (The loop that used to sit here
// was `for..in` over an ARRAY, so it walked "0".."227" and every lookup missed anyway.) Writing it
// as an honest `for..of` would be a regression, not a fix: it would instantiate all 228 parsers on
// the WebView's cold-boot path. loadLanguage() below already builds the one parser a note needs.

export function parseExtension(name: string) {
	const normalized = name.toLowerCase().trim()

	if (!normalized.includes(".")) {
		return ""
	}

	const parts = normalized.split(".")
	const lastPart = parts[parts.length - 1]

	return `.${lastPart}`
}

export function loadLanguage(name: string) {
	const lang = parseExtension(name).replace(".", "")

	// Own-key guard: a bare langs[...] lookup would resolve "constructor"/"__proto__"
	if (!langNames.includes(lang as keyof typeof langs)) {
		return null
	}

	const load = langs[lang as keyof typeof langs]

	if (!load) {
		return null
	}

	return load()
}

type TextThemePalette = {
	selection: string
	gutterBorder: string
	gutterBackground: string
	gutterForeground: string
	comment: string
	variableName: string
	string: string
	number: string
	boolNull: string
	keyword: string
	keywordWeight: string
	operator: string
	typeName: string
	definition: string
	angleBracket: string
	tagName: string
	attributeName: string
}

// macOS system colors on iOS, GNOME palette elsewhere
const PALETTES: Record<"macOS" | "linux", Record<"light" | "dark", TextThemePalette>> = {
	macOS: {
		light: {
			selection: "#007AFF40",
			gutterBorder: "#C7C7CC",
			gutterBackground: "#FFFFFF",
			gutterForeground: "#8E8E93",
			comment: "#8E8E93",
			variableName: "#007AFF",
			string: "#34C759",
			number: "#FF9500",
			boolNull: "#5856D6",
			keyword: "#FF2D55",
			keywordWeight: "600",
			operator: "#8E8E93",
			typeName: "#5856D6",
			definition: "#FF3B30",
			angleBracket: "#8E8E93",
			tagName: "#FF9500",
			attributeName: "#007AFF"
		},
		dark: {
			selection: "#0A84FF40",
			gutterBorder: "#3A3A3C",
			gutterBackground: "transparent",
			gutterForeground: "#8E8E93",
			comment: "#8E8E93",
			variableName: "#0A84FF",
			string: "#30D158",
			number: "#FF9F0A",
			boolNull: "#BF5AF2",
			keyword: "#FF375F",
			keywordWeight: "600",
			operator: "#8E8E93",
			typeName: "#BF5AF2",
			definition: "#FF453A",
			angleBracket: "#8E8E93",
			tagName: "#FF9F0A",
			attributeName: "#0A84FF"
		}
	},
	linux: {
		light: {
			selection: "#3584E440",
			gutterBorder: "#CDC7C2",
			gutterBackground: "#FAFAFA",
			gutterForeground: "#77767B",
			comment: "#77767B",
			variableName: "#3584E4",
			string: "#33D17A",
			number: "#F57C00",
			boolNull: "#9141AC",
			keyword: "#E01B24",
			keywordWeight: "bold",
			operator: "#5E5C64",
			typeName: "#1C71D8",
			definition: "#C01C28",
			angleBracket: "#77767B",
			tagName: "#F57C00",
			attributeName: "#613583"
		},
		dark: {
			selection: "#62A0EA40",
			gutterBorder: "#3D3846",
			gutterBackground: "transparent",
			gutterForeground: "#9A9996",
			comment: "#9A9996",
			variableName: "#62A0EA",
			string: "#8FF0A4",
			number: "#FFBE6F",
			boolNull: "#DC8ADD",
			keyword: "#F66151",
			keywordWeight: "bold",
			operator: "#C0BFBC",
			typeName: "#99C1F1",
			definition: "#F8E45C",
			angleBracket: "#9A9996",
			tagName: "#FFBE6F",
			attributeName: "#62A0EA"
		}
	}
}

export function createTextTheme({
	platform,
	darkMode,
	backgroundColor,
	textForegroundColor
}: {
	platform: Platform["OS"]
	darkMode: boolean
	backgroundColor: string
	textForegroundColor: string
}) {
	const p = PALETTES[platform === "ios" ? "macOS" : "linux"][darkMode ? "dark" : "light"]

	return createTheme({
		theme: darkMode ? "dark" : "light",
		settings: {
			background: backgroundColor,
			foreground: textForegroundColor,
			selection: p.selection,
			selectionMatch: p.selection,
			lineHighlight: "transparent",
			gutterBorder: `1px solid ${p.gutterBorder}`,
			gutterBackground: p.gutterBackground,
			gutterForeground: p.gutterForeground,
			fontFamily: "var(--font-sans)"
		},
		styles: [
			{
				tag: t.comment,
				color: p.comment,
				fontStyle: "italic"
			},
			{
				tag: t.variableName,
				color: p.variableName
			},
			{
				tag: [t.string, t.special(t.brace)],
				color: p.string
			},
			{
				tag: t.number,
				color: p.number
			},
			{
				tag: t.bool,
				color: p.boolNull
			},
			{
				tag: t.null,
				color: p.boolNull
			},
			{
				tag: t.keyword,
				color: p.keyword,
				fontWeight: p.keywordWeight
			},
			{
				tag: t.operator,
				color: p.operator
			},
			{
				tag: t.className,
				color: p.typeName
			},
			{
				tag: t.definition(t.typeName),
				color: p.definition
			},
			{
				tag: t.typeName,
				color: p.typeName
			},
			{
				tag: t.angleBracket,
				color: p.angleBracket
			},
			{
				tag: t.tagName,
				color: p.tagName
			},
			{
				tag: t.attributeName,
				color: p.attributeName
			}
		]
	})
}
