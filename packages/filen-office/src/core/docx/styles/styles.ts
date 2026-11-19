import type { XmlDocument } from "../../xml/index"
import { EMPTY_CELL, EMPTY_PARAGRAPH, EMPTY_ROW, EMPTY_RUN, EMPTY_TABLE } from "../props/parse"
import { PropsReader } from "../props/reader"
import type { PropsStore } from "../props/store"
import type { ParagraphProps, RunProps, TableCellProps, TableProps, TableRowProps } from "../props/types"

// word/styles.xml (ECMA-376 Part 1 §17.7).

export type StyleType = "paragraph" | "character" | "table" | "numbering"

// ST_TblStyleOverrideType (§17.18.89).
export type TableStyleType =
	| "wholeTable"
	| "firstRow"
	| "lastRow"
	| "firstCol"
	| "lastCol"
	| "band1Vert"
	| "band2Vert"
	| "band1Horz"
	| "band2Horz"
	| "neCell"
	| "nwCell"
	| "seCell"
	| "swCell"

export const TABLE_STYLE_TYPES: readonly TableStyleType[] = [
	"wholeTable",
	"firstRow",
	"lastRow",
	"firstCol",
	"lastCol",
	"band1Vert",
	"band2Vert",
	"band1Horz",
	"band2Horz",
	"neCell",
	"nwCell",
	"seCell",
	"swCell"
]

// One w:tblStylePr: formatting for a region of a table.
export interface TableStyleCondition {
	readonly paragraph: ParagraphProps
	readonly run: RunProps
	readonly table: TableProps
	readonly row: TableRowProps
	readonly cell: TableCellProps
}

export interface StyleDef {
	// Dense index into DocxStyles.styles.
	readonly index: number
	readonly id: string
	readonly type: StyleType
	readonly name: string | undefined
	// Lower-cased, whitespace-collapsed name: Word writes built-in names in English ("heading 1") whatever
	// the UI language, while style ids are localised ("berschrift1").
	readonly canonicalName: string | undefined
	readonly aliases: readonly string[]
	readonly isDefault: boolean
	readonly custom: boolean
	readonly basedOn: string | undefined
	readonly next: string | undefined
	readonly link: string | undefined
	readonly hidden: boolean
	readonly semiHidden: boolean
	readonly unhideWhenUsed: boolean
	readonly quickFormat: boolean
	readonly locked: boolean
	readonly uiPriority: number | undefined
	readonly paragraph: ParagraphProps
	readonly run: RunProps
	readonly table: TableProps
	readonly row: TableRowProps
	readonly cell: TableCellProps
	readonly conditions: ReadonlyMap<TableStyleType, TableStyleCondition>
	// The w:style element, for the writer.
	readonly node: number
}

export interface LatentStyle {
	readonly name: string
	readonly locked: boolean | undefined
	readonly uiPriority: number | undefined
	readonly semiHidden: boolean | undefined
	readonly unhideWhenUsed: boolean | undefined
	readonly quickFormat: boolean | undefined
}

export interface LatentStyles {
	readonly defaultLocked: boolean
	readonly defaultUiPriority: number | undefined
	readonly defaultSemiHidden: boolean
	readonly defaultUnhideWhenUsed: boolean
	readonly defaultQuickFormat: boolean
	readonly count: number | undefined
	// By canonical name.
	readonly exceptions: ReadonlyMap<string, LatentStyle>
}

const EMPTY_LATENT: LatentStyles = {
	defaultLocked: false,
	defaultUiPriority: undefined,
	defaultSemiHidden: false,
	defaultUnhideWhenUsed: false,
	defaultQuickFormat: false,
	count: undefined,
	exceptions: new Map()
}

export function canonicalStyleName(name: string): string {
	return name.trim().replace(/\s+/g, " ").toLowerCase()
}

const HEADING_NAME = /^heading ([1-9])$/

// The level of the built-in heading style ("heading 1".."heading 9") canonical name `name` names.
export function headingLevelOfName(name: string): number | undefined {
	const match = HEADING_NAME.exec(name)

	return match === null ? undefined : Number(match[1])
}

// The level of a built-in heading style, by canonical name.
export function headingLevel(style: StyleDef): number | undefined {
	return style.canonicalName === undefined ? undefined : headingLevelOfName(style.canonicalName)
}

// Deeper basedOn chains are cut: Word documents use a handful of levels, hostile ones thousands.
export const MAX_STYLE_DEPTH = 64

function styleType(value: string | undefined): StyleType {
	return value === "character" || value === "table" || value === "numbering" ? value : "paragraph"
}

export class DocxStyles {
	readonly defaultRun: RunProps
	readonly defaultParagraph: ParagraphProps
	readonly styles: readonly StyleDef[]
	readonly latent: LatentStyles
	// A start tag in styles.xml could not be read or repeats an attribute: the document is view-only.
	readonly malformed: boolean
	private readonly byIdMap: ReadonlyMap<string, StyleDef>
	private lowerIdMap: Map<string, StyleDef> | null = null
	private nameMap: Map<string, StyleDef> | null = null
	private readonly defaults: ReadonlyMap<StyleType, StyleDef>
	private parents: Int32Array | null = null
	private reverseLinks: Map<number, StyleDef> | null = null

	constructor(
		defaultRun: RunProps,
		defaultParagraph: ParagraphProps,
		styles: readonly StyleDef[],
		latent: LatentStyles,
		malformed: boolean = false
	) {
		this.malformed = malformed
		this.defaultRun = defaultRun
		this.defaultParagraph = defaultParagraph
		this.styles = styles
		this.latent = latent

		const byId = new Map<string, StyleDef>()
		const defaults = new Map<StyleType, StyleDef>()

		for (const style of styles) {
			// Ids must be unique; the first definition wins, as for the default of each type.
			if (!byId.has(style.id)) byId.set(style.id, style)
			if (style.isDefault && !defaults.has(style.type)) defaults.set(style.type, style)
		}

		this.byIdMap = byId
		this.defaults = defaults
	}

	static empty(): DocxStyles {
		return new DocxStyles(EMPTY_RUN, EMPTY_PARAGRAPH, [], EMPTY_LATENT)
	}

	// Exact id first, then case-insensitively (some producers change the case of ids they reference).
	byId(id: string): StyleDef | undefined {
		const exact = this.byIdMap.get(id)

		if (exact !== undefined) return exact

		if (this.lowerIdMap === null) {
			this.lowerIdMap = new Map()

			for (const style of this.styles) {
				const key = style.id.toLowerCase()

				if (!this.lowerIdMap.has(key)) this.lowerIdMap.set(key, style)
			}
		}

		return this.lowerIdMap.get(id.toLowerCase())
	}

	// By canonical name or alias ("heading 1", "Title", "List Paragraph"), optionally of one type.
	byName(name: string, type?: StyleType): StyleDef | undefined {
		if (this.nameMap === null) {
			this.nameMap = new Map()

			for (const style of this.styles) {
				const keys = style.canonicalName === undefined ? style.aliases : [style.canonicalName, ...style.aliases]

				for (const key of keys) {
					const typed = `${style.type}\u0000${key}`

					if (!this.nameMap.has(typed)) this.nameMap.set(typed, style)
					if (!this.nameMap.has(key)) this.nameMap.set(key, style)
				}
			}
		}

		const key = canonicalStyleName(name)

		return this.nameMap.get(type === undefined ? key : `${type}\u0000${key}`)
	}

	defaultOf(type: StyleType): StyleDef | undefined {
		return this.defaults.get(type)
	}

	// A built-in style Word knows by name but the document does not define (a latent style is no definition).
	isLatentOnly(name: string): boolean {
		const key = canonicalStyleName(name)

		return this.latent.exceptions.has(key) && this.byName(key) === undefined
	}

	// The style a basedOn names: one of the same type, else none. Cycles are cut where the member with the
	// lowest index points back into the cycle, and chains deeper than MAX_STYLE_DEPTH are cut at that depth,
	// so every style has one fixed parent whatever order styles are resolved in.
	parent(style: StyleDef): StyleDef | undefined {
		this.parents ??= this.linkParents()

		return this.styles[this.parents[style.index] ?? -1]
	}

	// The basedOn chain, root first and `style` last (at most MAX_STYLE_DEPTH styles).
	chain(style: StyleDef): StyleDef[] {
		const out: StyleDef[] = []

		for (let current: StyleDef | undefined = style; current !== undefined; current = this.parent(current)) out.push(current)

		return out.reverse()
	}

	// The other half of a linked paragraph/character pair. A link written on one side only counts both
	// ways (MS-OI29500, Part 1 §17.7.4.6 note b).
	linked(style: StyleDef): StyleDef | undefined {
		const forward = style.link === undefined ? undefined : this.byId(style.link)

		if (forward !== undefined && forward.type !== style.type) return forward

		if (this.reverseLinks === null) {
			this.reverseLinks = new Map()

			for (const candidate of this.styles) {
				const target = candidate.link === undefined ? undefined : this.byId(candidate.link)

				if (target !== undefined && target.type !== candidate.type && !this.reverseLinks.has(target.index)) {
					this.reverseLinks.set(target.index, candidate)
				}
			}
		}

		return this.reverseLinks.get(style.index)
	}

	private linkParents(): Int32Array {
		const count = this.styles.length
		const parents = new Int32Array(count).fill(-1)

		for (const style of this.styles) {
			const parent = style.basedOn === undefined ? undefined : this.byId(style.basedOn)

			if (parent !== undefined && parent.type === style.type && parent.index !== style.index) parents[style.index] = parent.index
		}

		// Each style has at most one parent, so following parents from any style ends at a root or in a cycle.
		const state = new Uint8Array(count)
		const path: number[] = []

		for (let start = 0; start < count; start++) {
			path.length = 0

			let node = start

			while (node >= 0 && state[node] === 0) {
				state[node] = 1
				path.push(node)
				node = parents[node] ?? -1
			}

			if (node >= 0 && state[node] === 1) {
				const cycle = path.slice(path.indexOf(node))

				parents[cycle.reduce((lowest, member) => Math.min(lowest, member), count)] = -1
			}

			for (const visited of path) state[visited] = 2
		}

		// Depth from the root, parents first: a style past the cap starts a chain of its own.
		const depth = new Int32Array(count).fill(-1)

		for (let start = 0; start < count; start++) {
			path.length = 0

			for (let node = start; node >= 0 && depth[node] === -1; node = parents[node] ?? -1) path.push(node)

			for (let k = path.length - 1; k >= 0; k--) {
				const node = path[k] ?? 0
				const parent = parents[node] ?? -1
				const below = parent < 0 ? -1 : (depth[parent] ?? -1)

				if (below + 1 >= MAX_STYLE_DEPTH) {
					parents[node] = -1
					depth[node] = 0
				} else {
					depth[node] = below + 1
				}
			}
		}

		return parents
	}
}

function readCondition(r: PropsReader, store: PropsStore, node: number): TableStyleCondition {
	const document = r.document

	return {
		paragraph: store.paragraph(document, r.child(node, "pPr")),
		run: store.run(document, r.child(node, "rPr")),
		table: store.table(document, r.child(node, "tblPr")),
		row: store.row(document, r.child(node, "trPr")),
		cell: store.cell(document, r.child(node, "tcPr"))
	}
}

function readLatent(r: PropsReader, node: number): LatentStyles {
	const document = r.document
	const exceptions = new Map<string, LatentStyle>()

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (r.local(child) !== "lsdException") continue

		const name = r.string(child, "name")

		if (name === undefined) continue

		exceptions.set(canonicalStyleName(name), {
			name,
			locked: r.optionalOnOff(child, "locked"),
			uiPriority: r.integer(child, "uiPriority"),
			semiHidden: r.optionalOnOff(child, "semiHidden"),
			unhideWhenUsed: r.optionalOnOff(child, "unhideWhenUsed"),
			quickFormat: r.optionalOnOff(child, "qFormat")
		})
	}

	return {
		defaultLocked: r.onOff(node, "defLockedState", false),
		defaultUiPriority: r.integer(node, "defUIPriority"),
		defaultSemiHidden: r.onOff(node, "defSemiHidden", false),
		defaultUnhideWhenUsed: r.onOff(node, "defUnhideWhenUsed", false),
		defaultQuickFormat: r.onOff(node, "defQFormat", false),
		count: r.integer(node, "count"),
		exceptions
	}
}

function readStyle(r: PropsReader, store: PropsStore, node: number, index: number, id: string): StyleDef {
	const document = r.document
	let name: string | undefined
	const aliases: string[] = []
	let basedOn: string | undefined
	let next: string | undefined
	let link: string | undefined
	let hidden = false
	let semiHidden = false
	let unhideWhenUsed = false
	let quickFormat = false
	let locked = false
	let uiPriority: number | undefined
	let paragraph = EMPTY_PARAGRAPH
	let run = EMPTY_RUN
	let table = EMPTY_TABLE
	let row = EMPTY_ROW
	let cell = EMPTY_CELL
	const conditions = new Map<TableStyleType, TableStyleCondition>()

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		switch (r.local(child)) {
			case "name":
				name = r.string(child, "val")
				break
			case "aliases":
				for (const alias of (r.string(child, "val") ?? "").split(",")) {
					const trimmed = alias.trim()

					if (trimmed.length > 0) aliases.push(canonicalStyleName(trimmed))
				}

				break
			case "basedOn":
				basedOn = r.string(child, "val")
				break
			case "next":
				next = r.string(child, "val")
				break
			case "link":
				link = r.string(child, "val")
				break
			case "hidden":
				hidden = r.toggle(child)
				break
			case "semiHidden":
				semiHidden = r.toggle(child)
				break
			case "unhideWhenUsed":
				unhideWhenUsed = r.toggle(child)
				break
			case "qFormat":
				quickFormat = r.toggle(child)
				break
			case "locked":
				locked = r.toggle(child)
				break
			case "uiPriority":
				uiPriority = r.integer(child, "val")
				break
			case "pPr":
				paragraph = store.paragraph(document, child)
				break
			case "rPr":
				run = store.run(document, child)
				break
			case "tblPr":
				table = store.table(document, child)
				break
			case "trPr":
				row = store.row(document, child)
				break
			case "tcPr":
				cell = store.cell(document, child)
				break
			case "tblStylePr": {
				const type = r.string(child, "type") as TableStyleType | undefined

				if (type !== undefined && TABLE_STYLE_TYPES.includes(type) && !conditions.has(type)) {
					conditions.set(type, readCondition(r, store, child))
				}

				break
			}
		}
	}

	return {
		index,
		id,
		type: styleType(r.string(node, "type")),
		name,
		canonicalName: name === undefined ? undefined : canonicalStyleName(name),
		aliases,
		isDefault: r.onOff(node, "default", false),
		custom: r.onOff(node, "customStyle", false),
		basedOn,
		next,
		link,
		hidden,
		semiHidden,
		unhideWhenUsed,
		quickFormat,
		locked,
		uiPriority,
		paragraph,
		run,
		table,
		row,
		cell,
		conditions,
		node
	}
}

export function parseStyles(document: XmlDocument, store: PropsStore): DocxStyles {
	const r = PropsReader.for(document)
	const malformed = r.model.hasMalformed()
	const root = document.documentElement()

	if (root < 0 || r.local(root) !== "styles") return new DocxStyles(EMPTY_RUN, EMPTY_PARAGRAPH, [], EMPTY_LATENT, malformed)

	let defaultRun = EMPTY_RUN
	let defaultParagraph = EMPTY_PARAGRAPH
	let latent = EMPTY_LATENT
	const styles: StyleDef[] = []

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		switch (r.local(child)) {
			case "docDefaults": {
				const runDefault = r.child(child, "rPrDefault")
				const paragraphDefault = r.child(child, "pPrDefault")

				if (runDefault >= 0) defaultRun = store.run(document, r.child(runDefault, "rPr"))
				if (paragraphDefault >= 0) defaultParagraph = store.paragraph(document, r.child(paragraphDefault, "pPr"))

				break
			}
			case "latentStyles":
				latent = readLatent(r, child)
				break
			case "style": {
				const id = r.string(child, "styleId")

				if (id !== undefined) styles.push(readStyle(r, store, child, styles.length, id))

				break
			}
		}
	}

	return new DocxStyles(defaultRun, defaultParagraph, styles, latent, malformed)
}
