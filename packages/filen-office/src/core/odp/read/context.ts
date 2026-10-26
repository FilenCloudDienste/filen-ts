import {
	NO_PROPERTIES,
	OdfStyleResolver,
	canonicalAttributes,
	elementName,
	parseLength,
	parsePercent,
	type OdfProperties,
	type OdfStyleSheet,
	type StyleScope
} from "../../odf/index"
import type { DeckTally, PresentationBudgets } from "../../presentation/budget"
import type { SlideRef, SourceRef } from "../../presentation/model"
import { tooLarge } from "../../presentation/refusal"
import type { Namespaces, XmlDocument } from "../../xml/index"

// What every ODP reading function shares: the style sheet and its resolver, the budgets and the deck's tallies,
// the page names (for jumps), and one parsed fragment (a page of content.xml, or styles.xml whole) with canonical
// names (namespaces compared by URI, Part 3 §1.5).

export class Fragment {
	readonly document: XmlDocument
	readonly namespaces: Namespaces
	// The stream ("content.xml", "styles.xml") and the fragment's byte offset in it (-1: the whole stream).
	readonly part: string
	readonly offset: number
	readonly scope: StyleScope
	readonly epoch: number
	private readonly names = new Map<number, string>()

	constructor(document: XmlDocument, namespaces: Namespaces, part: string, offset: number, scope: StyleScope, epoch: number) {
		this.document = document
		this.namespaces = namespaces
		this.part = part
		this.offset = offset
		this.scope = scope
		this.epoch = epoch
	}

	name(node: number): string {
		let name = this.names.get(node)

		if (name === undefined) {
			name = elementName(this.document, this.namespaces, node)
			this.names.set(node, name)
		}

		return name
	}

	attributes(node: number): ReadonlyMap<string, string> {
		return canonicalAttributes(this.document, this.namespaces, node)
	}

	src(node: number): SourceRef {
		return { format: "odp", part: this.part, fragment: this.offset, node, epoch: this.epoch }
	}
}

const FONT_INDEPENDENT = "style:font-independent-line-spacing"
const RELATIVE_SIZE = new Set(["fo:font-size", "style:font-size-asian", "style:font-size-complex"])

// Properties of `own` over `base`, a percent font size taken of the base's (§20.190).
export function overlay(base: OdfProperties, own: OdfProperties): OdfProperties {
	if (own.attributes.size === 0 && own.children.length === 0) return base
	if (base.attributes.size === 0 && base.children.length === 0) return own

	const attributes = new Map(base.attributes)

	for (const [name, value] of own.attributes) {
		if (RELATIVE_SIZE.has(name)) {
			const percent = parsePercent(value)
			const parent = parseLength(base.attributes.get(name))

			if (percent !== undefined && parent !== undefined) {
				attributes.set(name, `${String(Math.round(parent * percent * 100) / 10_000)}pt`)

				continue
			}
		}

		attributes.set(name, value)
	}

	const replaced = new Set(own.children.map(child => child.name))

	return { attributes, children: [...base.children.filter(child => !replaced.has(child.name)), ...own.children] }
}

// table:table-template (ODF 1.3 Part 3 §9.4): the cell style of each role.
export type TableTemplate = ReadonlyMap<string, string>

export interface TableFlags {
	readonly firstRow: boolean
	readonly lastRow: boolean
	readonly firstCol: boolean
	readonly lastCol: boolean
	readonly bandRow: boolean
	readonly bandCol: boolean
}

// What the package tells the reader beside the styles: manifest media types and the table templates.
export interface PackageFacts {
	mediaType(path: string): string | undefined
	// Whether the package has a stream (a picture an object's replacement names).
	has(path: string): boolean
	readonly templates: ReadonlyMap<string, TableTemplate>
}

export interface OwnStyle {
	readonly paragraph: OdfProperties
	readonly text: OdfProperties
}

export class OdpContext {
	readonly sheet: OdfStyleSheet
	readonly resolver: OdfStyleResolver
	readonly budgets: PresentationBudgets
	readonly tally: DeckTally
	pageCount = 0
	private readonly pages: ReadonlyMap<string, SlideRef>
	private fields = 0
	private readonly owned = new Map<string, OdfProperties>()

	private readonly facts: PackageFacts

	constructor(
		sheet: OdfStyleSheet,
		budgets: PresentationBudgets,
		tally: DeckTally,
		pages: ReadonlyMap<string, SlideRef>,
		facts: PackageFacts
	) {
		this.facts = facts
		this.sheet = sheet
		this.resolver = new OdfStyleResolver(sheet)
		this.budgets = budgets
		this.tally = tally
		this.pages = pages
	}

	// The manifest media type of a part ("/Object 1"), or undefined.
	mediaType(part: string | undefined): string | undefined {
		return part === undefined ? undefined : this.facts.mediaType(part)
	}

	hasPart(part: string): boolean {
		return this.facts.has(part)
	}

	// An embedded object that is a chart (its manifest entry says so, Part 2 §4.3).
	isChart(part: string): boolean {
		return this.facts.mediaType(part) === "application/vnd.oasis.opendocument.chart"
	}

	// The cell style a table template gives a cell by its position: first and last row, first and last column,
	// banded rows and columns, else the body (§9.4.2–§9.4.11, in that precedence, as LibreOffice applies them).
	template(
		name: string | undefined
	): ((row: number, rows: number, column: number, columns: number, flags: TableFlags) => string | undefined) | undefined {
		const template = name === undefined ? undefined : this.facts.templates.get(name)

		if (template === undefined) return undefined

		return (row, rows, column, columns, flags) => {
			if (flags.firstRow && row === 0) return template.get("first-row") ?? template.get("body")
			if (flags.lastRow && row === rows - 1) return template.get("last-row") ?? template.get("body")
			if (flags.firstCol && column === 0) return template.get("first-column") ?? template.get("body")
			if (flags.lastCol && columns > 0 && column === columns - 1) return template.get("last-column") ?? template.get("body")
			if (flags.bandRow) {
				const index = row - (flags.firstRow ? 1 : 0)

				return (index % 2 === 0 ? template.get("odd-rows") : template.get("even-rows")) ?? template.get("body")
			}

			if (flags.bandCol) {
				const index = column - (flags.firstCol ? 1 : 0)

				return (index % 2 === 0 ? template.get("odd-columns") : template.get("even-columns")) ?? template.get("body")
			}

			return template.get("body")
		}
	}

	pageNamed(name: string): SlideRef | undefined {
		return this.pages.get(name)
	}

	fieldId(): string {
		this.fields++

		return `{odp-field-${String(this.fields)}}`
	}

	// Runs and characters a body added, against the per-slide and per-deck budgets.
	countRuns(runs: number, characters: number): void {
		const tally = this.tally

		tally.partRuns += runs
		tally.characters += characters

		if (tally.partRuns > this.budgets.runsPerSlide) tooLarge("text runs on a slide", this.budgets.runsPerSlide)
		if (tally.characters > this.budgets.charactersPerDeck) tooLarge("characters in the deck", this.budgets.charactersPerDeck)
	}

	// A style's properties of one kind along its own chain (its parents), without the family's default style: what
	// an automatic paragraph or span style adds over the shape's text defaults.
	ownProperties(family: string, name: string, scope: StyleScope, kind: string): OdfProperties {
		const key = `${scope}\u0000${family}\u0000${name}\u0000${kind}`
		let held = this.owned.get(key)

		if (held === undefined) {
			held = NO_PROPERTIES

			for (const style of this.resolver.resolve(family, name, scope).chain)
				if (!style.isDefault) held = overlay(held, style.properties.get(kind) ?? NO_PROPERTIES)

			this.owned.set(key, held)
		}

		return held
	}

	ownStyle(family: string, name: string, scope: StyleScope): OwnStyle {
		return { paragraph: this.ownProperties(family, name, scope, "paragraph"), text: this.ownProperties(family, name, scope, "text") }
	}

	// A shape's style, one property kind: the graphic default style, the master's presentation style of the shape's
	// class (`base`: LibreOffice gives every presentation object its master's style sheet, an automatic style
	// without a parent adding to it), its graphic style (draw:style-name), its presentation style.
	shapeProperties(
		graphic: string | undefined,
		presentation: string | undefined,
		scope: StyleScope,
		kind: string,
		base?: string
	): OdfProperties {
		let out = this.sheet.defaults.get("graphic")?.properties.get(kind) ?? NO_PROPERTIES

		// The presentation family's default style under a presentation object's chain: only the line-spacing rule is
		// taken from it (§20.297), the rest of the shape's defaults stay the graphic ones.
		if (kind === "paragraph" && (base !== undefined || presentation !== undefined)) {
			const rule = this.sheet.defaults.get("presentation")?.properties.get(kind)?.attributes.get(FONT_INDEPENDENT)

			if (rule !== undefined) out = overlay(out, { attributes: new Map([[FONT_INDEPENDENT, rule]]), children: [] })
		}

		if (base !== undefined) out = overlay(out, this.ownProperties("presentation", base, "styles", kind))
		if (graphic !== undefined) out = overlay(out, this.ownProperties("graphic", graphic, scope, kind))
		if (presentation !== undefined) out = overlay(out, this.ownProperties("presentation", presentation, scope, kind))

		return out
	}

	// A presentation style's own properties of one kind, without its parents (an automatic style's hard attributes).
	ownOnly(name: string, scope: StyleScope, kind: string): OdfProperties {
		return this.sheet.style("presentation", name, scope)?.properties.get(kind) ?? NO_PROPERTIES
	}

	hasPresentationStyle(name: string): boolean {
		return this.sheet.style("presentation", name, "styles") !== undefined
	}
}
