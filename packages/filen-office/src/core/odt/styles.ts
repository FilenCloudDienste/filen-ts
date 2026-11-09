import {
	parseLength,
	parsePercent,
	type OdfElement,
	type OdfStyle,
	type OdfStyleResolver,
	type OdfStyleSheet,
	type StyleScope
} from "../odf/index"
import { defaultPageRtl } from "./pages"
import { paragraphProperties, runProperties, setsIndent, type Attributes, type PropsSink } from "./props"
import type { OdtLossyReason } from "./types"
import { esc } from "./wml"

// Common styles become w:style (parent → basedOn), the paragraph family's default style the document
// defaults, and an automatic style becomes direct formatting over its common parent: the WordprocessingML
// reading of "automatic over common" (Part 3 §16.2).

// LibreOffice Writer's defaults where a document's default style leaves a property out.
const DEFAULT_FONT = "Liberation Serif"
const DEFAULT_SIZE = 12

export interface ParagraphStyle {
	// The w:style the paragraph names (the common style, or an automatic style's parent).
	readonly styleId: string | undefined
	// Properties written as direct formatting: an automatic style's own, with inherited percents resolved.
	readonly paragraph: Attributes
	readonly children: readonly OdfElement[]
	readonly text: Attributes
	// The paragraph's own properties set an indent (they then win over a list level's).
	readonly ownIndent: boolean
	// With inheritance, for values that combine or are looked up.
	readonly resolvedParagraph: Attributes
	readonly resolvedText: Attributes
	readonly fontSize: number
	// What the common style it names (with the styles it is based on) approximates: the paragraph shows that too.
	readonly reasons: readonly OdtLossyReason[]
	// The tab stops the common style it names gives, and the margin its w:style placed them from.
	readonly inheritedTabs: InheritedTabs | undefined
}

export interface InheritedTabs {
	readonly stops: OdfElement
	readonly marginLeft: number
}

// A common style translated once: its w:style and what that approximates.
interface CommonStyle {
	readonly xml: string
	readonly reasons: readonly OdtLossyReason[]
}

const NO_REASONS: readonly OdtLossyReason[] = []

export interface StyleOptions {
	readonly tabsRelativeToIndent: boolean
	// Paragraph styles kept mapped up to this many (all by default); past it, mapped again when asked for.
	readonly keepAtMost?: number
}

const NO_ATTRIBUTES: Attributes = new Map()

// Own attributes with their resolved values (a percent of the parent's size becomes a length).
function ownResolved(own: Attributes | undefined, resolved: Attributes): Attributes {
	if (own === undefined || own.size === 0) return NO_ATTRIBUTES

	const out = new Map<string, string>()

	for (const [name, value] of own) out.set(name, resolved.get(name) ?? value)

	return out
}

export class StyleMapper {
	private readonly sheet: OdfStyleSheet
	private readonly resolver: OdfStyleResolver
	private readonly options: StyleOptions
	private readonly paragraphCache = new Map<string, ParagraphStyle>()
	private readonly runCache = new Map<string, string>()
	private readonly commonCache = new Map<string, CommonStyle>()
	private readonly chainCache = new Map<string, readonly OdtLossyReason[]>()
	private readonly tabsCache = new Map<string, InheritedTabs | null>()
	readonly defaultParagraphStyle: string | undefined
	// The first page style's direction: what the styles' "page" writing mode (or none) is translated as.
	readonly pageRtl: boolean

	constructor(sheet: OdfStyleSheet, resolver: OdfStyleResolver, options: StyleOptions) {
		this.sheet = sheet
		this.resolver = resolver
		this.options = options
		this.defaultParagraphStyle = sheet.commonStyle("paragraph", "Standard") !== undefined ? "Standard" : undefined
		this.pageRtl = defaultPageRtl(sheet)
	}

	paragraphStyleId(name: string): string {
		return name
	}

	characterStyleId(name: string): string {
		return `T_${name}`
	}

	// The paragraph style a text:p or text:h names, as WordprocessingML sees it.
	paragraph(name: string | undefined, scope: StyleScope): ParagraphStyle {
		const key = `${scope}\u0000${name ?? ""}`
		let style = this.paragraphCache.get(key)

		if (style !== undefined) return style

		const odf = name === undefined ? undefined : this.sheet.style("paragraph", name, scope)
		const resolved = this.resolver.resolve("paragraph", odf === undefined ? this.defaultParagraphStyle : name, scope)
		const resolvedParagraph = resolved.properties("paragraph").attributes
		const resolvedText = resolved.properties("text").attributes
		const fontSize = parseLength(resolvedText.get("fo:font-size")) ?? DEFAULT_SIZE

		if (odf?.automatic === true) {
			const own = odf.properties.get("paragraph")
			const parent =
				odf.parent !== undefined && this.sheet.commonStyle("paragraph", odf.parent) !== undefined
					? odf.parent
					: this.defaultParagraphStyle

			style = {
				styleId: parent === undefined ? undefined : this.paragraphStyleId(parent),
				reasons: parent === undefined ? NO_REASONS : this.reasons("paragraph", parent),
				inheritedTabs: this.inheritedTabs(parent),
				paragraph: ownResolved(own?.attributes, resolvedParagraph),
				children: own?.children ?? [],
				text: ownResolved(odf.properties.get("text")?.attributes, resolvedText),
				ownIndent: own !== undefined && setsIndent(own.attributes),
				resolvedParagraph,
				resolvedText,
				fontSize
			}
		} else {
			const common = odf === undefined ? this.defaultParagraphStyle : odf.name

			style = {
				styleId: common === undefined ? undefined : this.paragraphStyleId(common),
				reasons: common === undefined ? NO_REASONS : this.reasons("paragraph", common),
				inheritedTabs: this.inheritedTabs(common),
				paragraph: NO_ATTRIBUTES,
				children: [],
				text: NO_ATTRIBUTES,
				ownIndent: false,
				resolvedParagraph,
				resolvedText,
				fontSize
			}
		}

		if (this.paragraphCache.size >= (this.options.keepAtMost ?? Infinity)) this.paragraphCache.clear()

		this.paragraphCache.set(key, style)

		return style
	}

	// A text style (text:span, text:a) as rStyle plus its direct attributes.
	text(
		name: string | undefined,
		scope: StyleScope
	): { readonly styleId: string | undefined; readonly own: Attributes; readonly reasons: readonly OdtLossyReason[] } {
		const odf = name === undefined ? undefined : this.sheet.style("text", name, scope)

		if (odf === undefined) return { styleId: undefined, own: NO_ATTRIBUTES, reasons: NO_REASONS }

		if (!odf.automatic) return { styleId: this.characterStyleId(odf.name), own: NO_ATTRIBUTES, reasons: this.reasons("text", odf.name) }

		const parent = odf.parent !== undefined && this.sheet.commonStyle("text", odf.parent) !== undefined ? odf.parent : undefined

		return {
			styleId: parent === undefined ? undefined : this.characterStyleId(parent),
			reasons: parent === undefined ? NO_REASONS : this.reasons("text", parent),
			own: ownResolved(
				odf.properties.get("text")?.attributes,
				this.resolver.resolve("text", name, scope).properties("text").attributes
			)
		}
	}

	// rPr for text with `attributes` direct (merged paragraph and span properties), cached by key.
	runProperties(key: string, styleId: string | undefined, attributes: Attributes, fontSize: number, sink: PropsSink): string {
		const cacheKey = `${styleId ?? ""}\u0000${key}`
		let rPr = this.runCache.get(cacheKey)

		if (rPr === undefined) {
			rPr = `${styleId === undefined ? "" : `<w:rStyle w:val="${esc(styleId)}"/>`}${runProperties(this.sheet, attributes, sink, fontSize)}`
			this.runCache.set(cacheKey, rPr)
		}

		return rPr
	}

	// A span's own font size given as a percent: of the paragraph's size (an automatic text style has no parent).
	static relativeSize(attributes: Attributes, paragraphSize: number): Attributes {
		const size = attributes.get("fo:font-size")
		const percent = parsePercent(size)

		if (percent === undefined) return attributes

		const out = new Map(attributes)

		out.set("fo:font-size", `${(paragraphSize * percent) / 100}pt`)

		return out
	}

	// styles.xml: defaults, the common paragraph and text styles.
	stylesXml(sink: PropsSink): string {
		const defaults = this.sheet.defaults.get("paragraph")
		const defaultText = new Map(defaults?.properties.get("text")?.attributes ?? [])

		if (!defaultText.has("style:font-name") && !defaultText.has("fo:font-family")) defaultText.set("fo:font-family", DEFAULT_FONT)
		if (!defaultText.has("fo:font-size")) defaultText.set("fo:font-size", `${DEFAULT_SIZE}pt`)

		const defaultParagraph = defaults?.properties.get("paragraph")
		const pPr = paragraphProperties(
			defaultParagraph?.attributes ?? NO_ATTRIBUTES,
			defaultParagraph?.children ?? [],
			defaultParagraph?.attributes ?? NO_ATTRIBUTES,
			{
				tabsRelativeToIndent: this.options.tabsRelativeToIndent,
				marginLeft: 0,
				indents: false,
				fontSize: DEFAULT_SIZE,
				hyphenate: defaults?.properties.get("text")?.attributes.get("fo:hyphenate"),
				pageRtl: this.pageRtl,
				// No writing mode is "page" (§20.404.3): every style inherits the first page's direction from here.
				bidi: this.pageRtl ? true : undefined
			},
			sink
		)
		let xml = `<w:docDefaults><w:rPrDefault><w:rPr>${runProperties(this.sheet, defaultText, sink)}</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>${pPr.head}${pPr.tail}</w:pPr></w:pPrDefault></w:docDefaults>`

		if (this.defaultParagraphStyle === undefined) {
			xml += '<w:style w:type="paragraph" w:default="1" w:styleId="OdfDefault"><w:name w:val="Normal"/></w:style>'
		}

		xml +=
			'<w:style w:type="character" w:default="1" w:styleId="OdfDefaultCharacter"><w:name w:val="Default Paragraph Font"/></w:style>'
		xml +=
			'<w:style w:type="table" w:default="1" w:styleId="OdfTable"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'

		for (const family of ["paragraph", "text"] as const) {
			for (const style of this.sheet.commonStyles(family)) {
				const common = this.common(family, style)

				for (const reason of common.reasons) sink.lossy(reason)

				xml += common.xml
			}
		}

		return xml
	}

	// A common style's w:style and its reasons, translated once (blocks ask before styles.xml is written).
	private common(family: "paragraph" | "text", style: OdfStyle): CommonStyle {
		const key = `${family}\u0000${style.name}`
		let common = this.commonCache.get(key)

		if (common === undefined) {
			const reasons = new Set<OdtLossyReason>()
			const collect: PropsSink = { lossy: reason => reasons.add(reason) }
			const xml = family === "paragraph" ? this.paragraphStyleXml(style, collect) : this.characterStyleXml(style, collect)

			common = { xml, reasons: reasons.size === 0 ? NO_REASONS : [...reasons] }
			this.commonCache.set(key, common)
		}

		return common
	}

	// The tab stops a common paragraph style gives (its own or the nearest style's it is based on that sets them,
	// ODF replacing them whole), with the left margin that style's w:style placed them from (paragraphStyleXml).
	private inheritedTabs(name: string | undefined): InheritedTabs | undefined {
		if (name === undefined) return undefined

		let found = this.tabsCache.get(name)

		if (found === undefined) {
			found = null

			const seen = new Set<string>()

			for (let style = this.sheet.commonStyle("paragraph", name); style !== undefined && !seen.has(style.name);) {
				seen.add(style.name)

				const stops = style.properties.get("paragraph")?.children.find(child => child.name === "style:tab-stops")

				if (stops !== undefined) {
					const margin = this.resolver
						.resolve("paragraph", style.name, "styles")
						.properties("paragraph")
						.attributes.get("fo:margin-left")

					found = { stops, marginLeft: parseLength(margin) ?? 0 }
					break
				}

				style = style.parent === undefined || style.parent === "" ? undefined : this.sheet.commonStyle("paragraph", style.parent)
			}

			this.tabsCache.set(name, found)
		}

		return found ?? undefined
	}

	// The reasons of a common style and the common styles it is based on (a cycle or a missing parent ends the
	// chain, as the resolver's inheritance does).
	private reasons(family: "paragraph" | "text", name: string): readonly OdtLossyReason[] {
		const key = `${family}\u0000${name}`
		let found = this.chainCache.get(key)

		if (found !== undefined) return found

		const reasons = new Set<OdtLossyReason>()
		const seen = new Set<string>()

		for (let style = this.sheet.commonStyle(family, name); style !== undefined && !seen.has(style.name);) {
			seen.add(style.name)

			for (const reason of this.common(family, style).reasons) reasons.add(reason)

			style = style.parent === undefined || style.parent === "" ? undefined : this.sheet.commonStyle(family, style.parent)
		}

		found = reasons.size === 0 ? NO_REASONS : [...reasons]
		this.chainCache.set(key, found)

		return found
	}

	private paragraphStyleXml(style: OdfStyle, sink: PropsSink): string {
		const resolved = this.resolver.resolve("paragraph", style.name, "styles")
		const resolvedParagraph = resolved.properties("paragraph").attributes
		const resolvedText = resolved.properties("text").attributes
		const own = style.properties.get("paragraph")
		const ownIndent = own !== undefined && setsIndent(own.attributes)
		const pPr = paragraphProperties(
			ownResolved(own?.attributes, resolvedParagraph),
			own?.children ?? [],
			resolvedParagraph,
			{
				tabsRelativeToIndent: this.options.tabsRelativeToIndent,
				marginLeft: parseLength(resolvedParagraph.get("fo:margin-left")) ?? 0,
				indents: ownIndent,
				fontSize: parseLength(resolvedText.get("fo:font-size")) ?? DEFAULT_SIZE,
				hyphenate: style.properties.get("text")?.attributes.get("fo:hyphenate"),
				pageRtl: this.pageRtl
			},
			sink
		)
		const parent =
			style.parent !== undefined && style.parent !== "" && this.sheet.commonStyle("paragraph", style.parent) !== undefined
				? `<w:basedOn w:val="${esc(this.paragraphStyleId(style.parent))}"/>`
				: ""
		const nextName = style.attributes.get("style:next-style-name")
		const next =
			nextName !== undefined && this.sheet.commonStyle("paragraph", nextName) !== undefined
				? `<w:next w:val="${esc(this.paragraphStyleId(nextName))}"/>`
				: ""
		const outline = Number(style.attributes.get("style:default-outline-level") ?? "0")
		const outlineXml = outline >= 1 && outline <= 9 ? `<w:outlineLvl w:val="${outline - 1}"/>` : ""
		const isDefault = style.name === this.defaultParagraphStyle ? ' w:default="1"' : ""
		const name = style.name === this.defaultParagraphStyle ? "Normal" : (style.displayName ?? style.name)
		const rPr = runProperties(this.sheet, ownResolved(style.properties.get("text")?.attributes, resolvedText), sink)

		return `<w:style w:type="paragraph"${isDefault} w:styleId="${esc(this.paragraphStyleId(style.name))}"><w:name w:val="${esc(name)}"/>${parent}${next}<w:qFormat/><w:pPr>${pPr.head}${pPr.tail}${outlineXml}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`
	}

	private characterStyleXml(style: OdfStyle, sink: PropsSink): string {
		const resolved = this.resolver.resolve("text", style.name, "styles").properties("text").attributes
		const parent =
			style.parent !== undefined && style.parent !== "" && this.sheet.commonStyle("text", style.parent) !== undefined
				? `<w:basedOn w:val="${esc(this.characterStyleId(style.parent))}"/>`
				: ""

		return `<w:style w:type="character" w:styleId="${esc(this.characterStyleId(style.name))}"><w:name w:val="${esc(`${style.displayName ?? style.name} (text)`)}"/>${parent}<w:rPr>${runProperties(this.sheet, ownResolved(style.properties.get("text")?.attributes, resolved), sink)}</w:rPr></w:style>`
	}
}
