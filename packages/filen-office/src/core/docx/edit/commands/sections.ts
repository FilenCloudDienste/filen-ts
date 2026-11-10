import { MAX_TWIPS, boolArg, choiceArg, field, intArg, optional, type DocxCommandInfo, type DocxCommandParser } from "./base"

// Headers and footers, section breaks and page setup.

export type DocxSectionBreak = "nextPage" | "continuous" | "evenPage" | "oddPage"
export type DocxOrientation = "portrait" | "landscape"
// ST_NumberFormat values Word offers for page numbers.
export const DOCX_PAGE_NUMBER_FORMATS = ["decimal", "upperRoman", "lowerRoman", "upperLetter", "lowerLetter", "numberInDash"] as const

export type DocxPageNumberFormat = (typeof DOCX_PAGE_NUMBER_FORMATS)[number]

// Twips throughout. Fields left out stay as they are.
export interface DocxPageSetup {
	readonly size?: { readonly width: number; readonly height: number }
	readonly orientation?: DocxOrientation
	readonly margins?: {
		readonly top?: number
		readonly bottom?: number
		readonly left?: number
		readonly right?: number
		readonly header?: number
		readonly footer?: number
		readonly gutter?: number
	}
	readonly columns?: { readonly count: number; readonly space?: number; readonly separator?: boolean }
	// `start` null: numbering continues from the previous section.
	readonly pageNumbers?: { readonly start?: number | null; readonly format?: DocxPageNumberFormat }
	// Line numbers in the margin (null: none): every `countBy`th line, from `start`, `distance` from the text.
	readonly lineNumbers?: {
		readonly countBy: number
		readonly start?: number
		readonly distance?: number
		readonly restart?: DocxLineNumberRestart
	} | null
	// Mirror margins (Word's Multiple pages "Mirror margins"): left and right are inside and outside, swapped on
	// facing pages (w:mirrorMargins in settings, ECMA-376 Part 1 §17.15.1.57). Document-wide, whatever `scope`.
	readonly mirrorMargins?: boolean
	// The caret's section (default) or every section, as Word's "Apply to".
	readonly scope?: "section" | "document"
}

export type DocxLineNumberRestart = "newPage" | "newSection" | "continuous"

export type SectionCommand =
	| { readonly type: "insert.sectionBreak"; readonly kind: DocxSectionBreak }
	| { readonly type: "header.edit" }
	| { readonly type: "footer.edit" }
	| { readonly type: "header.differentFirst" }
	| { readonly type: "header.differentOddEven" }
	| { readonly type: "header.linkToPrevious" }
	// The header (footer) of the caret's page goes: its section shows the one before it has, if any.
	| { readonly type: "header.remove" }
	| { readonly type: "footer.remove" }
	// The section break ending the caret's section goes: its text joins the section after it.
	| { readonly type: "section.deleteBreak" }
	| ({ readonly type: "page.setup" } & DocxPageSetup)

const document = { write: true, scope: "document" } as const

export const SECTION_COMMANDS: readonly DocxCommandInfo<SectionCommand["type"]>[] = [
	{
		type: "insert.sectionBreak",
		labelKey: "docx.insert.sectionBreak",
		icon: "section-break",
		group: "section",
		input: "sectionBreak",
		...document
	},
	// Entering a header or footer changes nothing until one has to be made.
	{ type: "header.edit", labelKey: "docx.header.edit", icon: "header", group: "header", context: "header", ...document },
	{ type: "footer.edit", labelKey: "docx.footer.edit", icon: "footer", group: "header", context: "header", ...document },
	{
		type: "header.differentFirst",
		labelKey: "docx.header.differentFirst",
		icon: "header-first",
		group: "header",
		context: "header",
		...document
	},
	{
		type: "header.differentOddEven",
		labelKey: "docx.header.differentOddEven",
		icon: "header-odd-even",
		group: "header",
		context: "header",
		...document
	},
	{
		type: "header.linkToPrevious",
		labelKey: "docx.header.linkToPrevious",
		icon: "header-link",
		group: "header",
		context: "header",
		...document
	},
	{ type: "header.remove", labelKey: "docx.header.remove", icon: "header-remove", group: "header", context: "header", ...document },
	{ type: "footer.remove", labelKey: "docx.footer.remove", icon: "footer-remove", group: "header", context: "header", ...document },
	{ type: "section.deleteBreak", labelKey: "docx.section.deleteBreak", icon: "section-break-delete", group: "section", ...document },
	// No key of Word's; one a user binds opens the host's dialog.
	{
		type: "page.setup",
		labelKey: "docx.page.setup",
		icon: "page-setup",
		hostShortcut: true,
		group: "section",
		input: "pageSetup",
		...document
	}
]

const BREAKS = new Set<string>(["nextPage", "continuous", "evenPage", "oddPage"])
const ORIENTATIONS = new Set<string>(["portrait", "landscape"])
const FORMATS = new Set<string>(DOCX_PAGE_NUMBER_FORMATS)
const LINE_RESTARTS = new Set<string>(["newPage", "newSection", "continuous"])
const SCOPES = new Set<string>(["section", "document"])
// Word's page sizes: 0.1 to 22 inches.
const MIN_PAGE = 144

function object(value: object, key: string): object | null | undefined {
	const out = field(value, key)

	if (out === undefined) return undefined

	return typeof out === "object" && out !== null && !Array.isArray(out) ? out : null
}

const margin = (holder: object, key: string) => intArg(holder, key, -MAX_TWIPS, MAX_TWIPS)

function margins(value: object): DocxPageSetup["margins"] | null | undefined {
	const holder = object(value, "margins")

	if (holder === undefined || holder === null) return holder

	const out: Record<string, number> = {}

	for (const key of ["top", "bottom", "left", "right", "header", "footer", "gutter"]) {
		const parsed = optional(holder, key, key === "top" || key === "bottom" ? margin : (h, k) => intArg(h, k, 0, MAX_TWIPS))

		if (!parsed.ok) return null
		if (parsed.value !== undefined) out[key] = parsed.value
	}

	return Object.keys(out).length === 0 ? null : out
}

function pageSetup(value: object): DocxPageSetup | undefined {
	const out: { -readonly [K in keyof DocxPageSetup]: DocxPageSetup[K] } = {}
	const size = object(value, "size")

	if (size === null) return undefined

	if (size !== undefined) {
		const width = intArg(size, "width", MIN_PAGE, MAX_TWIPS)
		const height = intArg(size, "height", MIN_PAGE, MAX_TWIPS)

		if (width === undefined || height === undefined) return undefined

		out.size = { width, height }
	}

	const orientation = optional(value, "orientation", (holder, key) => choiceArg<DocxOrientation>(holder, key, ORIENTATIONS))

	if (!orientation.ok) return undefined
	if (orientation.value !== undefined) out.orientation = orientation.value

	const marginsOf = margins(value)

	if (marginsOf === null) return undefined
	if (marginsOf !== undefined) out.margins = marginsOf

	const columns = object(value, "columns")

	if (columns === null) return undefined

	if (columns !== undefined) {
		// Word allows 45 columns.
		const count = intArg(columns, "count", 1, 45)
		const space = optional(columns, "space", (holder, key) => intArg(holder, key, 0, MAX_TWIPS))
		const separator = optional(columns, "separator", boolArg)

		if (count === undefined || !space.ok || !separator.ok) return undefined

		out.columns = {
			count,
			...(space.value === undefined ? {} : { space: space.value }),
			...(separator.value === undefined ? {} : { separator: separator.value })
		}
	}

	const numbers = object(value, "pageNumbers")

	if (numbers === null) return undefined

	if (numbers !== undefined) {
		const start =
			field(numbers, "start") === null
				? { ok: true, value: null }
				: optional(numbers, "start", (holder, key) => intArg(holder, key, 0, 32767))
		const format = optional(numbers, "format", (holder, key) => choiceArg<DocxPageNumberFormat>(holder, key, FORMATS))

		if (!start.ok || !format.ok || (start.value === undefined && format.value === undefined)) return undefined

		out.pageNumbers = {
			...(start.value === undefined ? {} : { start: start.value }),
			...(format.value === undefined ? {} : { format: format.value })
		}
	}

	const lines = field(value, "lineNumbers")

	if (lines === null) {
		out.lineNumbers = null
	} else if (lines !== undefined) {
		const holder = object(value, "lineNumbers")

		if (holder === null || holder === undefined) return undefined

		// Word counts by 1 to 100, starts at 1 to 32767 and sets the distance up to 22 inches.
		const countBy = intArg(holder, "countBy", 1, 100)
		const start = optional(holder, "start", (h, key) => intArg(h, key, 1, 32767))
		const distance = optional(holder, "distance", (h, key) => intArg(h, key, 0, MAX_TWIPS))
		const restart = optional(holder, "restart", (h, key) => choiceArg<DocxLineNumberRestart>(h, key, LINE_RESTARTS))

		if (countBy === undefined || !start.ok || !distance.ok || !restart.ok) return undefined

		out.lineNumbers = {
			countBy,
			...(start.value === undefined ? {} : { start: start.value }),
			...(distance.value === undefined ? {} : { distance: distance.value }),
			...(restart.value === undefined ? {} : { restart: restart.value })
		}
	}

	const mirror = optional(value, "mirrorMargins", boolArg)

	if (!mirror.ok) return undefined
	if (mirror.value !== undefined) out.mirrorMargins = mirror.value

	if (Object.keys(out).length === 0) return undefined

	const scope = optional(value, "scope", (holder, key) => choiceArg<"section" | "document">(holder, key, SCOPES))

	if (!scope.ok) return undefined
	if (scope.value !== undefined) out.scope = scope.value

	return out
}

export const parseSectionCommand: DocxCommandParser<SectionCommand> = (type, value) => {
	switch (type) {
		case "insert.sectionBreak": {
			const kind = choiceArg<DocxSectionBreak>(value, "kind", BREAKS)

			return kind === undefined ? undefined : { type, kind }
		}
		case "page.setup": {
			const setup = pageSetup(value)

			return setup === undefined ? undefined : { type, ...setup }
		}
		default:
			return { type }
	}
}
