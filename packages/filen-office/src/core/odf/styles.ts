import { runSliced, sliceClock, type Slicing } from "../slicing"
import { Namespaces, type XmlDocument } from "../xml/index"
import type { ContentPrologue } from "./prologue"
import { canonicalAttributes, elementName, readElement, type OdfElement } from "./tree"

// The stream whose content refers to a style: automatic styles of content.xml serve the body, those of
// styles.xml serve master pages (headers, footers). Common styles serve both (Part 3 §3.15, §16.2).
export type StyleScope = "styles" | "content"

// One *-properties element: its attributes by canonical name (shorthands expanded, see SHORTHANDS) and its
// child elements (style:tab-stops, style:columns, style:background-image...).
export interface OdfProperties {
	readonly attributes: ReadonlyMap<string, string>
	readonly children: readonly OdfElement[]
}

export const NO_PROPERTIES: OdfProperties = { attributes: new Map(), children: [] }

// style:map (§16.3): a conditional style.
export interface OdfStyleMap {
	readonly condition: string
	readonly applyStyleName: string
	readonly baseCellAddress: string | undefined
}

// style:style or style:default-style (§16.2, §16.4).
export interface OdfStyle {
	readonly family: string
	// "" for a default style.
	readonly name: string
	readonly isDefault: boolean
	readonly automatic: boolean
	readonly origin: StyleScope
	readonly displayName: string | undefined
	readonly parent: string | undefined
	// The element's own attributes by canonical name (style:list-style-name, style:master-page-name,
	// style:data-style-name, style:default-outline-level, style:class...). An attribute present but empty
	// (style:list-style-name="") is meaningful and kept.
	readonly attributes: ReadonlyMap<string, string>
	// By kind: "text", "paragraph", "table-cell"... for style:*-properties; "loext:graphic" for foreign ones.
	readonly properties: ReadonlyMap<string, OdfProperties>
	readonly maps: readonly OdfStyleMap[]
}

export interface OdfPageLayout {
	readonly name: string
	readonly automatic: boolean
	readonly origin: StyleScope
	readonly usage: string
	readonly properties: OdfProperties
	// style:header-style / style:footer-style header-footer-properties; undefined when absent.
	readonly header: OdfProperties | undefined
	readonly footer: OdfProperties | undefined
}

export type MasterRegionKind = "header" | "header-left" | "header-first" | "footer" | "footer-left" | "footer-first"

export interface OdfMasterRegion {
	readonly kind: MasterRegionKind
	// style:display="false" keeps the content but shows nothing.
	readonly display: boolean
	// The region element in OdfStyleSheet.stylesDocument, read by the document readers.
	readonly node: number
}

export interface OdfMasterPage {
	readonly name: string
	readonly displayName: string | undefined
	readonly pageLayout: string | undefined
	readonly next: string | undefined
	readonly drawStyle: string | undefined
	readonly regions: readonly OdfMasterRegion[]
	readonly node: number
}

export type ListLevelKind = "number" | "bullet" | "image"

export interface OdfListLevel {
	readonly level: number
	readonly kind: ListLevelKind
	// text:list-level-style-* attributes (style:num-format, text:bullet-char, text:start-value, text:display-levels...).
	readonly attributes: ReadonlyMap<string, string>
	readonly properties: OdfProperties
	// style:list-level-label-alignment inside the level properties (§17.20), when present.
	readonly labelAlignment: ReadonlyMap<string, string> | undefined
	readonly textProperties: OdfProperties | undefined
}

export interface OdfListStyle {
	readonly name: string
	readonly displayName: string | undefined
	readonly automatic: boolean
	readonly origin: StyleScope
	// text:outline-style (§16.36): the headings' numbering.
	readonly outline: boolean
	readonly consecutiveNumbering: boolean
	// Levels by number (1–10); a level the style leaves out is absent.
	readonly levels: ReadonlyMap<number, OdfListLevel>
}

export type DataStyleKind = "number" | "currency" | "percentage" | "date" | "time" | "boolean" | "text"

// number:*-style (§16.29): its own attributes, the format elements in order, conditions and text color.
export interface OdfDataStyle {
	readonly kind: DataStyleKind
	readonly name: string
	readonly automatic: boolean
	readonly origin: StyleScope
	readonly attributes: ReadonlyMap<string, string>
	// number:number, number:text, number:day, number:currency-symbol... in document order.
	readonly parts: readonly OdfElement[]
	readonly maps: readonly OdfStyleMap[]
	readonly textProperties: OdfProperties | undefined
}

export interface OdfFontFace {
	readonly name: string
	// svg:font-family without its CSS quotes.
	readonly family: string
	readonly generic: string | undefined
	readonly pitch: string | undefined
	readonly attributes: ReadonlyMap<string, string>
	// svg:font-face-uri targets: fonts embedded in the package (ODF 1.3 §16.23).
	readonly sources: readonly string[]
}

export type OdfStyleIssue =
	| { readonly kind: "missingParent"; readonly family: string; readonly name: string; readonly parent: string }
	| { readonly kind: "parentCycle"; readonly family: string; readonly name: string }
	| { readonly kind: "duplicate"; readonly what: string; readonly name: string }

const DATA_STYLE_KINDS: Readonly<Record<string, DataStyleKind>> = {
	"number:number-style": "number",
	"number:currency-style": "currency",
	"number:percentage-style": "percentage",
	"number:date-style": "date",
	"number:time-style": "time",
	"number:boolean-style": "boolean",
	"number:text-style": "text"
}

const LIST_LEVEL_KINDS: Readonly<Record<string, ListLevelKind>> = {
	"text:list-level-style-number": "number",
	"text:outline-level-style": "number",
	"text:list-level-style-bullet": "bullet",
	"text:list-level-style-image": "image"
}

const REGION_KINDS: ReadonlySet<string> = new Set(["header", "header-left", "header-first", "footer", "footer-left", "footer-first"])

// Shorthand attributes and the per-side attributes they stand for. A side given explicitly in the same element
// wins over the shorthand; the shorthand is then dropped, so a child's shorthand overrides all its parent's sides.
const SIDES = ["top", "bottom", "left", "right"] as const
const SHORTHANDS: readonly (readonly [string, (side: string) => string])[] = [
	["fo:margin", side => `fo:margin-${side}`],
	["fo:padding", side => `fo:padding-${side}`],
	["fo:border", side => `fo:border-${side}`],
	["style:border-line-width", side => `style:border-line-width-${side}`]
]

function expandShorthands(attributes: Map<string, string>): Map<string, string> {
	for (const [shorthand, sideName] of SHORTHANDS) {
		const value = attributes.get(shorthand)

		if (value === undefined) continue

		attributes.delete(shorthand)

		for (const side of SIDES) {
			const name = sideName(side)

			if (!attributes.has(name)) attributes.set(name, value)
		}
	}

	return attributes
}

export function propertiesKind(name: string): string | undefined {
	if (!name.endsWith("-properties")) return undefined

	const stem = name.slice(0, -"-properties".length)

	return stem.startsWith("style:") ? stem.slice("style:".length) : stem
}

function propertiesOf(element: OdfElement): OdfProperties {
	return { attributes: expandShorthands(new Map(element.attributes)), children: element.children }
}

function styleMaps(element: OdfElement): OdfStyleMap[] {
	const maps: OdfStyleMap[] = []

	for (const child of element.children) {
		if (child.name !== "style:map") continue

		maps.push({
			condition: child.attributes.get("style:condition") ?? "",
			applyStyleName: child.attributes.get("style:apply-style-name") ?? "",
			baseCellAddress: child.attributes.get("style:base-cell-address")
		})
	}

	return maps
}

function key(family: string, name: string): string {
	return `${family}\u0000${name}`
}

function unquoteFamily(value: string): string {
	const trimmed = value.trim()

	return trimmed.length >= 2 && (trimmed[0] === "'" || trimmed[0] === '"') && trimmed[trimmed.length - 1] === trimmed[0]
		? trimmed.slice(1, -1)
		: trimmed
}

// An automatic style not read yet: where it is, read when first asked for (a document holds thousands).
interface PendingStyle {
	readonly document: XmlDocument
	readonly namespaces: Namespaces
	readonly node: number
	readonly origin: StyleScope
	readonly family: string
	readonly name: string
	readonly parent: string | undefined
}

interface ScopeTables {
	readonly styles: Map<string, OdfStyle>
	// Automatic styles by key, read when asked for (and kept in `read`, up to the sheet's limit).
	readonly pending: Map<string, PendingStyle>
	readonly read: Map<string, OdfStyle>
	readonly lists: Map<string, OdfListStyle>
	readonly data: Map<string, OdfDataStyle>
}

function scopeTables(): ScopeTables {
	return { styles: new Map(), pending: new Map(), read: new Map(), lists: new Map(), data: new Map() }
}

// Every style a document has: common, default and automatic styles of both streams, page layouts, master
// pages, list, outline and data styles, font faces, notes and line-numbering configuration, and the named
// drawing resources (gradients, hatches, fill images, markers, dashes, opacities).
// Style elements read between looks at the slice clock.
const STYLES_PER_STEP = 64

export class OdfStyleSheet {
	readonly fontFaces = new Map<string, OdfFontFace>()
	readonly defaults = new Map<string, OdfStyle>()
	readonly pageLayouts = new Map<string, OdfPageLayout>()
	readonly masterPages = new Map<string, OdfMasterPage>()
	// Master pages in document order: the first is the one a document without a page-break style starts with.
	readonly masterOrder: string[] = []
	outlineStyle: OdfListStyle | undefined = undefined
	// text:notes-configuration by text:note-class ("footnote", "endnote").
	readonly notesConfiguration = new Map<string, ReadonlyMap<string, string>>()
	lineNumbering: ReadonlyMap<string, string> | undefined = undefined
	// Element name -> draw:name -> element.
	readonly drawResources = new Map<string, Map<string, OdfElement>>()
	readonly issues: OdfStyleIssue[] = []
	// styles.xml as parsed (master page regions point into it); undefined for a package without one.
	readonly stylesDocument: XmlDocument | undefined
	readonly stylesNamespaces: Namespaces | undefined
	private readonly common = scopeTables()
	private readonly automaticOf: Readonly<Record<StyleScope, ScopeTables>> = { styles: scopeTables(), content: scopeTables() }
	private defaultLayout: OdfPageLayout | undefined = undefined
	// The sheet an overlay (withAutomatic) reads through for what it does not hold itself.
	private base: OdfStyleSheet | undefined = undefined

	constructor(styles: XmlDocument | undefined, content: ContentPrologue | undefined, deferred = false) {
		this.stylesDocument = styles
		this.stylesNamespaces = styles === undefined ? undefined : new Namespaces(styles)

		if (deferred) return

		const steps = this.read(content)

		while (steps.next().done !== true) continue
	}

	// The sheet read in slices (a long prologue holds thousands of automatic styles).
	static async build(styles: XmlDocument | undefined, content: ContentPrologue | undefined, slicing: Slicing): Promise<OdfStyleSheet> {
		const sheet = new OdfStyleSheet(styles, content, true)

		await runSliced(sheet.read(content), sliceClock(slicing))

		return sheet
	}

	// This sheet with `content`'s automatic styles added to the content stream's (a written page's new styles read
	// back): the stream is not read again; what the overlay does not define is this sheet's. The overlay holds its own
	// copies of what reading a container may add to, so this sheet never changes.
	withAutomatic(content: ContentPrologue): OdfStyleSheet {
		const overlay = Object.create(this) as OdfStyleSheet
		const own = overlay as unknown as {
			base: OdfStyleSheet
			automaticOf: Record<StyleScope, ScopeTables>
			issues: OdfStyleIssue[]
			defaults: Map<string, OdfStyle>
			pageLayouts: Map<string, OdfPageLayout>
			notesConfiguration: Map<string, ReadonlyMap<string, string>>
		}

		own.base = this
		own.automaticOf = { styles: this.automaticOf.styles, content: scopeTables() }
		own.issues = []
		own.defaults = new Map(this.defaults)
		own.pageLayouts = new Map(this.pageLayouts)
		own.notesConfiguration = new Map(this.notesConfiguration)

		const steps = overlay.readStream(content.document, content.namespaces, content.root, "content")

		while (steps.next().done !== true) continue

		return overlay
	}

	get defaultPageLayout(): OdfPageLayout | undefined {
		return this.defaultLayout
	}

	// Both streams read, a step at a time.
	private *read(content: ContentPrologue | undefined): Generator<void> {
		const styles = this.stylesDocument

		if (styles !== undefined && this.stylesNamespaces !== undefined) {
			yield* this.readStream(styles, this.stylesNamespaces, styles.documentElement(), "styles")
		}

		if (content !== undefined) yield* this.readStream(content.document, content.namespaces, content.root, "content")

		this.checkParents()
	}

	// The style a `scope` stream's content names: its own automatic style first, then the common one.
	style(family: string, name: string, scope: StyleScope): OdfStyle | undefined {
		return this.automaticStyle(scope, key(family, name)) ?? this.common.styles.get(key(family, name))
	}

	// Automatic styles read are kept up to this many (all of them by default); past it, read again when asked for.
	// A translation reading a document in order asks for most of them once.
	keepAtMost = Infinity

	private automaticStyle(scope: StyleScope, styleKey: string): OdfStyle | undefined {
		const tables = this.automaticOf[scope]
		const known = tables.read.get(styleKey) ?? tables.styles.get(styleKey)

		if (known !== undefined) return known

		const pending = tables.pending.get(styleKey)

		if (pending === undefined) return this.base?.automaticStyle(scope, styleKey)

		const style = this.readStyle(readElement(pending.document, pending.namespaces, pending.node), true, pending.origin)

		if (style === undefined) return undefined
		if (tables.read.size >= this.keepAtMost) tables.read.clear()

		tables.read.set(styleKey, style)

		return style
	}

	// The names of a stream's automatic styles of `family` (read or not yet read), in no particular order.
	*automaticNames(family: string, scope: StyleScope): Generator<string> {
		const tables = this.automaticOf[scope]
		const prefix = key(family, "")

		for (const table of [tables.styles, tables.pending]) {
			for (const styleKey of table.keys()) if (styleKey.startsWith(prefix)) yield styleKey.slice(prefix.length)
		}

		if (this.base !== undefined && tables !== this.base.automaticOf[scope]) yield* this.base.automaticNames(family, scope)
	}

	// Common styles only: what style:parent-style-name and style:next-style-name refer to (§19.510).
	commonStyle(family: string, name: string): OdfStyle | undefined {
		return this.common.styles.get(key(family, name))
	}

	listStyle(name: string, scope: StyleScope): OdfListStyle | undefined {
		return this.automaticOf[scope].lists.get(name) ?? this.base?.listStyle(name, scope) ?? this.common.lists.get(name)
	}

	dataStyle(name: string, scope: StyleScope): OdfDataStyle | undefined {
		return this.automaticOf[scope].data.get(name) ?? this.base?.dataStyle(name, scope) ?? this.common.data.get(name)
	}

	// Common styles of a family, in no particular order (style pickers).
	*commonStyles(family?: string): IterableIterator<OdfStyle> {
		for (const style of this.common.styles.values()) if (family === undefined || style.family === family) yield style
	}

	private *readStream(document: XmlDocument, namespaces: Namespaces, root: number, origin: StyleScope): Generator<void> {
		for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
			switch (elementName(document, namespaces, node)) {
				case "office:font-face-decls":
					this.readFontFaces(document, namespaces, node)
					break
				case "office:styles":
					yield* this.readContainer(document, namespaces, node, origin, false)
					break
				case "office:automatic-styles":
					yield* this.readContainer(document, namespaces, node, origin, true)
					break
				case "office:master-styles":
					this.readMasterStyles(document, namespaces, node)
					break
			}
		}
	}

	private readFontFaces(document: XmlDocument, namespaces: Namespaces, container: number): void {
		for (let node = document.firstChildElement(container); node >= 0; node = document.nextSiblingElement(node)) {
			if (elementName(document, namespaces, node) !== "style:font-face") continue

			const element = readElement(document, namespaces, node)
			const name = element.attributes.get("style:name")

			if (name === undefined) continue

			const sources: string[] = []

			for (const source of element.children) {
				if (source.name !== "svg:font-face-src") continue

				for (const uri of source.children) {
					const href = uri.attributes.get("xlink:href")

					if (uri.name === "svg:font-face-uri" && href !== undefined) sources.push(href)
				}
			}

			this.fontFaces.set(name, {
				name,
				family: unquoteFamily(element.attributes.get("svg:font-family") ?? name),
				generic: element.attributes.get("style:font-family-generic"),
				pitch: element.attributes.get("style:font-pitch"),
				attributes: element.attributes,
				sources
			})
		}
	}

	private *readContainer(
		document: XmlDocument,
		namespaces: Namespaces,
		container: number,
		origin: StyleScope,
		automatic: boolean
	): Generator<void> {
		const tables = automatic ? this.automaticOf[origin] : this.common
		let read = 0

		for (let node = document.firstChildElement(container); node >= 0; node = document.nextSiblingElement(node)) {
			if (++read % STYLES_PER_STEP === 0) yield

			const name = elementName(document, namespaces, node)
			const dataKind = DATA_STYLE_KINDS[name]

			if (dataKind !== undefined) {
				const style = this.readDataStyle(readElement(document, namespaces, node), dataKind, automatic, origin)

				if (style !== undefined) this.put(tables.data, style.name, style, "dataStyle")

				continue
			}

			switch (name) {
				case "style:style":
				case "style:default-style": {
					if (automatic && name === "style:style") {
						const attributes = canonicalAttributes(document, namespaces, node)
						const family = attributes.get("style:family")
						const styleName = attributes.get("style:name")

						if (family === undefined || styleName === undefined) break

						const styleKey = key(family, styleName)
						const parent = attributes.get("style:parent-style-name")

						if (tables.styles.has(styleKey) || tables.pending.has(styleKey))
							this.issues.push({ kind: "duplicate", what: `style ${family}`, name: `${family}:${styleName}` })
						else tables.pending.set(styleKey, { document, namespaces, node, origin, family, name: styleName, parent })

						break
					}

					const style = this.readStyle(readElement(document, namespaces, node), automatic, origin)

					if (style === undefined) break

					if (style.isDefault) this.defaults.set(style.family, style)
					else this.put(tables.styles, key(style.family, style.name), style, `style ${style.family}`)

					break
				}
				case "text:list-style":
				case "text:outline-style": {
					const list = this.readListStyle(readElement(document, namespaces, node), automatic, origin)

					if (list.outline) this.outlineStyle = list
					else this.put(tables.lists, list.name, list, "listStyle")

					break
				}
				case "style:page-layout":
				case "style:default-page-layout": {
					const layout = this.readPageLayout(readElement(document, namespaces, node), automatic, origin)

					if (name === "style:default-page-layout") this.defaultLayout = layout
					else this.put(this.pageLayouts, layout.name, layout, "pageLayout")

					break
				}
				case "text:notes-configuration": {
					const attributes = canonicalAttributes(document, namespaces, node)

					this.notesConfiguration.set(attributes.get("text:note-class") ?? "footnote", attributes)

					break
				}
				case "text:linenumbering-configuration":
					this.lineNumbering = canonicalAttributes(document, namespaces, node)
					break
				default: {
					if (!name.startsWith("draw:") && !name.startsWith("svg:")) break

					const element = readElement(document, namespaces, node)
					const drawName = element.attributes.get("draw:name") ?? element.attributes.get("svg:name")

					if (drawName === undefined) break

					let resources = this.drawResources.get(name)

					if (resources === undefined) {
						resources = new Map()
						this.drawResources.set(name, resources)
					}

					resources.set(drawName, element)
				}
			}
		}
	}

	private put<T>(table: Map<string, T>, tableKey: string, value: T, what: string): void {
		if (table.has(tableKey)) this.issues.push({ kind: "duplicate", what, name: tableKey.replace("\u0000", ":") })

		// The first definition wins, as in LibreOffice.
		if (!table.has(tableKey)) table.set(tableKey, value)
	}

	private readStyle(element: OdfElement, automatic: boolean, origin: StyleScope): OdfStyle | undefined {
		const isDefault = element.name === "style:default-style"
		const family = element.attributes.get("style:family")
		const name = isDefault ? "" : element.attributes.get("style:name")

		if (family === undefined || name === undefined) return undefined

		const properties = new Map<string, OdfProperties>()

		for (const child of element.children) {
			const kind = propertiesKind(child.name)

			if (kind !== undefined) properties.set(kind, propertiesOf(child))
		}

		return {
			family,
			name,
			isDefault,
			automatic,
			origin,
			displayName: element.attributes.get("style:display-name"),
			parent: element.attributes.get("style:parent-style-name"),
			attributes: element.attributes,
			properties,
			maps: styleMaps(element)
		}
	}

	private readListStyle(element: OdfElement, automatic: boolean, origin: StyleScope): OdfListStyle {
		const levels = new Map<number, OdfListLevel>()

		for (const child of element.children) {
			const kind = LIST_LEVEL_KINDS[child.name]
			const level = Number(child.attributes.get("text:level") ?? "NaN")

			if (kind === undefined || !Number.isInteger(level) || level < 1 || level > 10 || levels.has(level)) continue

			let properties = NO_PROPERTIES
			let textProperties: OdfProperties | undefined
			let labelAlignment: ReadonlyMap<string, string> | undefined

			for (const part of child.children) {
				if (part.name === "style:list-level-properties") {
					properties = propertiesOf(part)
					labelAlignment = part.children.find(item => item.name === "style:list-level-label-alignment")?.attributes
				} else if (part.name === "style:text-properties") {
					textProperties = propertiesOf(part)
				}
			}

			levels.set(level, { level, kind, attributes: child.attributes, properties, labelAlignment, textProperties })
		}

		return {
			name: element.attributes.get("style:name") ?? "",
			displayName: element.attributes.get("style:display-name"),
			automatic,
			origin,
			outline: element.name === "text:outline-style",
			consecutiveNumbering: element.attributes.get("text:consecutive-numbering") === "true",
			levels
		}
	}

	private readDataStyle(element: OdfElement, kind: DataStyleKind, automatic: boolean, origin: StyleScope): OdfDataStyle | undefined {
		const name = element.attributes.get("style:name")

		if (name === undefined) return undefined

		let textProperties: OdfProperties | undefined
		const parts: OdfElement[] = []

		for (const child of element.children) {
			if (child.name === "style:text-properties") textProperties = propertiesOf(child)
			else if (child.name !== "style:map") parts.push(child)
		}

		return { kind, name, automatic, origin, attributes: element.attributes, parts, maps: styleMaps(element), textProperties }
	}

	private readPageLayout(element: OdfElement, automatic: boolean, origin: StyleScope): OdfPageLayout {
		let properties = NO_PROPERTIES
		let header: OdfProperties | undefined
		let footer: OdfProperties | undefined

		for (const child of element.children) {
			if (child.name === "style:page-layout-properties") {
				properties = propertiesOf(child)
			} else if (child.name === "style:header-style" || child.name === "style:footer-style") {
				const inner = child.children.find(item => item.name === "style:header-footer-properties")
				const value = inner === undefined ? NO_PROPERTIES : propertiesOf(inner)

				if (child.name === "style:header-style") header = value
				else footer = value
			}
		}

		return {
			name: element.attributes.get("style:name") ?? "",
			automatic,
			origin,
			usage: element.attributes.get("style:page-usage") ?? "all",
			properties,
			header,
			footer
		}
	}

	private readMasterStyles(document: XmlDocument, namespaces: Namespaces, container: number): void {
		for (let node = document.firstChildElement(container); node >= 0; node = document.nextSiblingElement(node)) {
			if (elementName(document, namespaces, node) !== "style:master-page") continue

			const attributes = canonicalAttributes(document, namespaces, node)
			const name = attributes.get("style:name")

			if (name === undefined) continue

			const regions: OdfMasterRegion[] = []

			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
				const childName = elementName(document, namespaces, child)

				if (!childName.startsWith("style:")) continue

				const kind = childName.slice("style:".length)

				if (!REGION_KINDS.has(kind)) continue

				regions.push({
					kind: kind as MasterRegionKind,
					display: canonicalAttributes(document, namespaces, child).get("style:display") !== "false",
					node: child
				})
			}

			if (this.masterPages.has(name)) {
				this.issues.push({ kind: "duplicate", what: "masterPage", name })

				continue
			}

			this.masterPages.set(name, {
				name,
				displayName: attributes.get("style:display-name"),
				pageLayout: attributes.get("style:page-layout-name"),
				next: attributes.get("style:next-style-name"),
				drawStyle: attributes.get("draw:style-name"),
				regions,
				node
			})
			this.masterOrder.push(name)
		}
	}

	private checkParents(): void {
		const tables = [
			this.common.styles,
			this.automaticOf.styles.styles,
			this.automaticOf.styles.pending,
			this.automaticOf.content.styles,
			this.automaticOf.content.pending
		]

		for (const table of tables) {
			for (const style of table.values()) {
				if (style.parent === undefined || style.parent === "") continue
				if (this.commonStyle(style.family, style.parent) === undefined) {
					this.issues.push({ kind: "missingParent", family: style.family, name: style.name, parent: style.parent })
				}
			}
		}
	}
}
