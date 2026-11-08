import {
	MAX_TWIPS,
	boolArg,
	choiceArg,
	field,
	hasControl,
	hexArg,
	intArg,
	optional,
	stringArg,
	type DocxCommandInfo,
	type DocxCommandParser
} from "./base"
import { insertable } from "./insert"

// Character and paragraph formatting beyond the base toggles, and the format painter.

// ST_HighlightColor.
export const DOCX_HIGHLIGHT_COLORS = [
	"none",
	"yellow",
	"green",
	"cyan",
	"magenta",
	"blue",
	"white",
	"red",
	"darkBlue",
	"darkCyan",
	"darkGreen",
	"darkMagenta",
	"darkRed",
	"darkYellow",
	"darkGray",
	"lightGray",
	"black"
] as const

export type DocxHighlightColor = (typeof DOCX_HIGHLIGHT_COLORS)[number]

// ST_ThemeColor.
export const DOCX_THEME_COLORS = [
	"dark1",
	"light1",
	"dark2",
	"light2",
	"accent1",
	"accent2",
	"accent3",
	"accent4",
	"accent5",
	"accent6",
	"hyperlink",
	"followedHyperlink",
	"background1",
	"text1",
	"background2",
	"text2"
] as const

export type DocxThemeColor = (typeof DOCX_THEME_COLORS)[number]

// A text colour: automatic, an RGB value ("RRGGBB"), or a theme colour with an optional tint or shade (0–255).
export type DocxTextColor =
	| { readonly kind: "auto" }
	| { readonly kind: "rgb"; readonly value: string }
	| { readonly kind: "theme"; readonly theme: DocxThemeColor; readonly tint?: number; readonly shade?: number }

export type DocxLineSpacingRule = "auto" | "exact" | "atLeast"

// The sizes Word's font size list offers (half-points); font.grow and font.shrink step through them.
export const DOCX_FONT_SIZES: readonly number[] = [16, 18, 20, 21, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 72, 96, 144]

// font.family values standing for the theme's fonts (Word's "+Body" and "+Headings").
export const DOCX_THEME_BODY_FONT = "+body"
export const DOCX_THEME_HEADINGS_FONT = "+headings"

export type FormattingCommand =
	| { readonly type: "format.superscript" }
	| { readonly type: "format.subscript" }
	| { readonly type: "format.doubleStrike" }
	| { readonly type: "format.smallCaps" }
	| { readonly type: "format.allCaps" }
	// w:u w:val="double" on, or underline off when all of the content has it.
	| { readonly type: "format.doubleUnderline" }
	// Word's Change Case (Shift+F3): the text itself, of the selection or the caret's word, cycled from lower
	// case to title case to upper case and back to lower case.
	| { readonly type: "format.changeCase" }
	// Character formatting cleared (as format.clear) and the paragraphs reset to Normal: Word's Clear All
	// Formatting.
	| { readonly type: "format.clearAll" }
	// A font name, or DOCX_THEME_BODY_FONT / DOCX_THEME_HEADINGS_FONT.
	| { readonly type: "font.family"; readonly family: string }
	// Half-points.
	| { readonly type: "font.size"; readonly halfPoints: number }
	| { readonly type: "font.grow" }
	| { readonly type: "font.shrink" }
	// One point larger (smaller).
	| { readonly type: "font.growPoint" }
	| { readonly type: "font.shrinkPoint" }
	// Character spacing in twips: positive expands, negative condenses, 0 is normal.
	| { readonly type: "font.spacing"; readonly twips: number }
	| { readonly type: "color.text"; readonly color: DocxTextColor }
	| { readonly type: "color.highlight"; readonly name: DocxHighlightColor }
	// "auto": `value` in 240ths of a line; "exact" and "atLeast": twips.
	| { readonly type: "paragraph.lineSpacing"; readonly rule: DocxLineSpacingRule; readonly value: number }
	// Twips.
	| { readonly type: "paragraph.spacing"; readonly before?: number; readonly after?: number }
	| {
			readonly type: "paragraph.indent"
			readonly start?: number
			readonly end?: number
			readonly firstLine?: number
			readonly hanging?: number
	  }
	// `sticky`: the painter stays on after a paste (a double click on it) until cancelled.
	| { readonly type: "format.copy"; readonly sticky?: boolean }
	| { readonly type: "format.paste" }

const story = { write: true, scope: "story" } as const

// Word's shortcuts. Shifted punctuation is named by its unshifted key ("mod+shift+." is Ctrl+Shift+>), which
// matchesShortcut compares by physical key.
export const FORMATTING_COMMANDS: readonly DocxCommandInfo<FormattingCommand["type"]>[] = [
	{
		type: "format.superscript",
		labelKey: "docx.format.superscript",
		icon: "superscript",
		shortcut: "mod+shift+=",
		group: "format",
		...story
	},
	{ type: "format.subscript", labelKey: "docx.format.subscript", icon: "subscript", shortcut: "mod+shift+-", group: "format", ...story },
	{ type: "format.doubleStrike", labelKey: "docx.format.doubleStrike", icon: "double-strikethrough", group: "format", ...story },
	{ type: "format.smallCaps", labelKey: "docx.format.smallCaps", icon: "small-caps", shortcut: "mod+shift+k", group: "format", ...story },
	{ type: "format.allCaps", labelKey: "docx.format.allCaps", icon: "all-caps", shortcut: "mod+shift+a", group: "format", ...story },
	{
		type: "format.doubleUnderline",
		labelKey: "docx.format.doubleUnderline",
		icon: "double-underline",
		shortcut: "mod+shift+d",
		group: "format",
		...story
	},
	{ type: "format.changeCase", labelKey: "docx.format.changeCase", icon: "change-case", shortcut: "shift+F3", group: "format", ...story },
	{ type: "format.clearAll", labelKey: "docx.format.clearAll", icon: "clear-all-formatting", group: "format", ...story },
	{ type: "font.family", labelKey: "docx.font.family", icon: "font-family", group: "font", input: "font", ...story },
	{ type: "font.size", labelKey: "docx.font.size", icon: "font-size", group: "font", input: "size", ...story },
	{ type: "font.grow", labelKey: "docx.font.grow", icon: "font-grow", shortcut: "mod+shift+.", group: "font", ...story },
	{ type: "font.shrink", labelKey: "docx.font.shrink", icon: "font-shrink", shortcut: "mod+shift+,", group: "font", ...story },
	{ type: "font.growPoint", labelKey: "docx.font.growPoint", icon: "font-grow", shortcut: "mod+]", group: "font", ...story },
	{ type: "font.shrinkPoint", labelKey: "docx.font.shrinkPoint", icon: "font-shrink", shortcut: "mod+[", group: "font", ...story },
	{ type: "font.spacing", labelKey: "docx.font.spacing", icon: "character-spacing", group: "font", ...story },
	{ type: "color.text", labelKey: "docx.color.text", icon: "text-color", group: "color", input: "color", ...story },
	{ type: "color.highlight", labelKey: "docx.color.highlight", icon: "highlight", group: "color", input: "highlight", ...story },
	{ type: "paragraph.lineSpacing", labelKey: "docx.paragraph.lineSpacing", icon: "line-spacing", group: "paragraph", ...story },
	{ type: "paragraph.spacing", labelKey: "docx.paragraph.spacing", icon: "paragraph-spacing", group: "paragraph", ...story },
	{ type: "paragraph.indent", labelKey: "docx.paragraph.indent", icon: "indent", group: "paragraph", ...story },
	// The painter's formatting is the editor's (it outlives story switches): document commands. Copying it
	// changes nothing; applying it does.
	{ type: "format.copy", labelKey: "docx.format.copy", icon: "format-painter", group: "painter", write: false, scope: "document" },
	{ type: "format.paste", labelKey: "docx.format.paste", icon: "format-painter", group: "painter", write: true, scope: "document" }
]

const HIGHLIGHTS = new Set<string>(DOCX_HIGHLIGHT_COLORS)
const THEMES = new Set<string>(DOCX_THEME_COLORS)
const RULES = new Set<string>(["auto", "exact", "atLeast"])
// Font sizes Word accepts: 1 to 1638 points.
export const MAX_HALF_POINTS = 3276

// A name to write as an attribute: no controls, noncharacters or lone surrogates.
function nameArg(value: object, key: string, max: number): string | undefined {
	const name = stringArg(value, key, max, 1)

	return name === undefined || hasControl(name) || name.trim() === "" || !insertable(name) ? undefined : name
}

function textColor(value: object): DocxTextColor | undefined {
	const color = field(value, "color")

	if (typeof color !== "object" || color === null) return undefined

	const kind = field(color, "kind")

	if (kind === "auto") return { kind }

	if (kind === "rgb") {
		const rgb = hexArg(color, "value")

		return rgb === undefined ? undefined : { kind, value: rgb }
	}

	if (kind !== "theme") return undefined

	const theme = choiceArg<DocxThemeColor>(color, "theme", THEMES)
	const tint = optional(color, "tint", (holder, key) => intArg(holder, key, 0, 255))
	const shade = optional(color, "shade", (holder, key) => intArg(holder, key, 0, 255))

	if (theme === undefined || !tint.ok || !shade.ok) return undefined

	return {
		kind,
		theme,
		...(tint.value === undefined ? {} : { tint: tint.value }),
		...(shade.value === undefined ? {} : { shade: shade.value })
	}
}

const twips = (min: number) => (holder: object, key: string) => intArg(holder, key, min, MAX_TWIPS)

export const parseFormattingCommand: DocxCommandParser<FormattingCommand> = (type, value) => {
	switch (type) {
		case "font.family": {
			// w:rFonts names: Word keeps at most 31 characters.
			const family = nameArg(value, "family", 31)

			return family === undefined ? undefined : { type, family }
		}
		case "font.size": {
			const halfPoints = intArg(value, "halfPoints", 2, MAX_HALF_POINTS)

			return halfPoints === undefined ? undefined : { type, halfPoints }
		}
		case "font.spacing": {
			const amount = intArg(value, "twips", -MAX_TWIPS, MAX_TWIPS)

			return amount === undefined ? undefined : { type, twips: amount }
		}
		case "format.copy": {
			const sticky = optional(value, "sticky", boolArg)

			if (!sticky.ok) return undefined

			return sticky.value === undefined ? { type } : { type, sticky: sticky.value }
		}
		case "color.text": {
			const color = textColor(value)

			return color === undefined ? undefined : { type, color }
		}
		case "color.highlight": {
			const name = choiceArg<DocxHighlightColor>(value, "name", HIGHLIGHTS)

			return name === undefined ? undefined : { type, name }
		}
		case "paragraph.lineSpacing": {
			const rule = choiceArg<DocxLineSpacingRule>(value, "rule", RULES)
			const amount =
				rule === undefined ? undefined : intArg(value, "value", rule === "auto" ? 1 : 0, rule === "auto" ? 31680 : MAX_TWIPS)

			return rule === undefined || amount === undefined ? undefined : { type, rule, value: amount }
		}
		case "paragraph.spacing": {
			const before = optional(value, "before", twips(0))
			const after = optional(value, "after", twips(0))

			if (!before.ok || !after.ok || (before.value === undefined && after.value === undefined)) return undefined

			return {
				type,
				...(before.value === undefined ? {} : { before: before.value }),
				...(after.value === undefined ? {} : { after: after.value })
			}
		}
		case "paragraph.indent": {
			const start = optional(value, "start", twips(-MAX_TWIPS))
			const end = optional(value, "end", twips(-MAX_TWIPS))
			const firstLine = optional(value, "firstLine", twips(0))
			const hanging = optional(value, "hanging", twips(0))

			if (!start.ok || !end.ok || !firstLine.ok || !hanging.ok) return undefined
			if (start.value === undefined && end.value === undefined && firstLine.value === undefined && hanging.value === undefined)
				return undefined
			// w:ind takes one of the two.
			if (firstLine.value !== undefined && hanging.value !== undefined) return undefined

			return {
				type,
				...(start.value === undefined ? {} : { start: start.value }),
				...(end.value === undefined ? {} : { end: end.value }),
				...(firstLine.value === undefined ? {} : { firstLine: firstLine.value }),
				...(hanging.value === undefined ? {} : { hanging: hanging.value })
			}
		}
		default:
			return { type } as FormattingCommand
	}
}
