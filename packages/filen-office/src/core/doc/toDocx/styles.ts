import { type DocChar, type DocPara, defaultChar, defaultPara } from "../props"
import { type DocStyle, ISTD_NIL, STK_CHARACTER, STK_NUMBERING, STK_PARAGRAPH, STK_TABLE, StyleResolver } from "../styles"
import type { DocModel } from "../model"
import { type PropsContext, paragraphProperties, runProperties } from "./props"
import { STORY_NAMESPACES, attr, val } from "./xml"

// STSH → styles.xml (ECMA-376 Part 1 §17.7.4): docDefaults from the STSHI default fonts and Word's built-in
// defaults, latent style defaults, then one w:style per STD with what it adds to its base style.

// sti (§2.9.? built-in style identifiers) → the names WordprocessingML gives built-in styles.
const BUILT_IN: readonly string[] = [
	"Normal",
	"heading 1",
	"heading 2",
	"heading 3",
	"heading 4",
	"heading 5",
	"heading 6",
	"heading 7",
	"heading 8",
	"heading 9",
	"index 1",
	"index 2",
	"index 3",
	"index 4",
	"index 5",
	"index 6",
	"index 7",
	"index 8",
	"index 9",
	"toc 1",
	"toc 2",
	"toc 3",
	"toc 4",
	"toc 5",
	"toc 6",
	"toc 7",
	"toc 8",
	"toc 9",
	"Normal Indent",
	"footnote text",
	"annotation text",
	"header",
	"footer",
	"index heading",
	"caption",
	"table of figures",
	"envelope address",
	"envelope return",
	"footnote reference",
	"annotation reference",
	"line number",
	"page number",
	"endnote reference",
	"endnote text",
	"table of authorities",
	"macro",
	"toa heading",
	"List",
	"List Bullet",
	"List Number",
	"List 2",
	"List 3",
	"List 4",
	"List 5",
	"List Bullet 2",
	"List Bullet 3",
	"List Bullet 4",
	"List Bullet 5",
	"List Number 2",
	"List Number 3",
	"List Number 4",
	"List Number 5",
	"Title",
	"Closing",
	"Signature",
	"Default Paragraph Font",
	"Body Text",
	"Body Text Indent",
	"List Continue",
	"List Continue 2",
	"List Continue 3",
	"List Continue 4",
	"List Continue 5",
	"Message Header",
	"Subtitle",
	"Salutation",
	"Date",
	"Body Text First Indent",
	"Body Text First Indent 2",
	"Note Heading",
	"Body Text 2",
	"Body Text 3",
	"Body Text Indent 2",
	"Body Text Indent 3",
	"Block Text",
	"Hyperlink",
	"FollowedHyperlink",
	"Strong",
	"Emphasis",
	"Document Map",
	"Plain Text"
]

// The styles of a converted document: ids by istd and the resolver the body writer diffs against.
export class StyleMap {
	readonly resolver: StyleResolver
	private readonly ids = new Map<number, string>()
	private readonly names = new Map<number, string>()
	private readonly model: DocModel

	constructor(model: DocModel) {
		this.model = model
		this.resolver = new StyleResolver(model.styles)

		// Style names are unique, compared without case (Word's rule; LibreOffice finds styles by name): built-in
		// styles keep their names, a stored name that repeats one ("Normal ", "normal") gets a number.
		const named = new Set<string>()
		const styles = model.styles.styles.flatMap((style, istd) => (style !== undefined && writable(style) ? [{ style, istd }] : []))
		const builtIn = ({ style }: { style: DocStyle }): boolean => style.sti < BUILT_IN.length

		for (const { style, istd } of [...styles.filter(builtIn), ...styles.filter(entry => !builtIn(entry))]) {
			const base = nameOf(style)
			let name = base

			for (let n = 2; named.has(name.toLowerCase()); n++) name = `${base} ${String(n)}`

			named.add(name.toLowerCase())
			this.names.set(istd, name)
		}

		const taken = new Set<string>()

		model.styles.styles.forEach((style, istd) => {
			if (style === undefined || !writable(style)) return

			const base = styleIdOf(this.name(istd)) || `Style${String(istd)}`
			let id = base

			for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base}${String(n)}`

			taken.add(id.toLowerCase())
			this.ids.set(istd, id)
		})
	}

	id(istd: number): string | undefined {
		return this.ids.get(istd)
	}

	name(istd: number): string {
		return this.names.get(istd) ?? `Style ${String(istd)}`
	}

	// The paragraph style a paragraph refers to (Normal for an istd without a paragraph style).
	paragraphStyle(istd: number): number {
		return this.model.styles.styles[istd]?.stk === STK_PARAGRAPH ? istd : 0
	}

	isCharacterStyle(istd: number): boolean {
		return this.model.styles.styles[istd]?.stk === STK_CHARACTER && this.ids.has(istd)
	}
}

function writable(style: DocStyle): boolean {
	return style.stk === STK_PARAGRAPH || style.stk === STK_CHARACTER || style.stk === STK_TABLE || style.stk === STK_NUMBERING
}

function nameOf(style: DocStyle): string {
	const builtIn = style.sti < BUILT_IN.length ? BUILT_IN[style.sti] : undefined

	if (builtIn !== undefined) return builtIn

	// Style names may hold aliases after a comma (§2.9.258 xstzName): the first is the name.
	const name = style.name.split(",")[0]?.trim() ?? ""

	return name === "" ? `Style ${String(style.istd)}` : name
}

function styleIdOf(name: string): string {
	return name.replace(/[^A-Za-z0-9]/gu, "")
}

// What WordprocessingML assumes with no rPrDefault: the base docDefaults are diffed against.
function implicitChar(): DocChar {
	const char = defaultChar()

	char.fontAscii = -1
	char.fontOther = -1
	char.fontEastAsia = -1
	char.fontBi = -1
	char.lang = 0x0400
	char.langEastAsia = 0x0400
	char.langBi = 0x0400
	// Always stated: applications differ in the size they assume without one.
	char.size = 0
	char.sizeBi = 0

	return char
}

function implicitPara(): DocPara {
	return { ...defaultPara(), widowControl: false }
}

export function stylesPart(model: DocModel, map: StyleMap, context: PropsContext, numIds: ReadonlySet<number>): string {
	const resolver = map.resolver
	const defaults = resolver.defaultChar
	const out: string[] = [`<w:styles ${STORY_NAMESPACES}>`]
	const charDefaults = runProperties(defaults, implicitChar(), context)
	const paraDefaults = paragraphProperties(defaultPara(), implicitPara(), context)

	out.push(
		`<w:docDefaults><w:rPrDefault><w:rPr>${charDefaults}</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>${paraDefaults}</w:pPr></w:pPrDefault></w:docDefaults>`
	)

	const count = Math.max(BUILT_IN.length, model.styles.stiMax ?? 0)

	out.push(
		`<w:latentStyles w:defLockedState="0" w:defUIPriority="99" w:defSemiHidden="0" w:defUnhideWhenUsed="0" w:defQFormat="0"${attr("w:count", count)}/>`
	)

	let defaultTable = false
	let defaultNumbering = false

	model.styles.styles.forEach((style, istd) => {
		const id = map.id(istd)

		if (style === undefined || id === undefined) return

		const type =
			style.stk === STK_PARAGRAPH
				? "paragraph"
				: style.stk === STK_CHARACTER
					? "character"
					: style.stk === STK_TABLE
						? "table"
						: "numbering"
		let isDefault = false

		if (style.stk === STK_PARAGRAPH && istd === 0) isDefault = true
		if (style.stk === STK_CHARACTER && istd === 10) isDefault = true

		if (style.stk === STK_TABLE && !defaultTable) {
			defaultTable = true
			isDefault = true
		}

		if (style.stk === STK_NUMBERING && !defaultNumbering) {
			defaultNumbering = true
			isDefault = true
		}

		out.push(`<w:style${attr("w:type", type)}${isDefault ? ' w:default="1"' : ""}${attr("w:styleId", id)}>`)
		out.push(val("name", map.name(istd)))

		// The rest of xstzName: aliases (§17.7.4.1), as Word writes them.
		const aliases = style.name
			.split(",")
			.slice(1)
			.map(alias => alias.trim())
			.filter(alias => alias !== "")

		if (aliases.length > 0) out.push(val("aliases", aliases.join(",")))

		const baseIstd = style.istdBase !== ISTD_NIL && style.istdBase !== istd ? style.istdBase : undefined
		const baseId = baseIstd === undefined ? undefined : map.id(baseIstd)
		const sameKind = baseIstd !== undefined && model.styles.styles[baseIstd]?.stk === style.stk

		if (baseId !== undefined && sameKind) out.push(val("basedOn", baseId))

		const nextId = style.istdNext !== ISTD_NIL ? map.id(style.istdNext) : undefined

		if (nextId !== undefined && style.stk === STK_PARAGRAPH && model.styles.styles[style.istdNext]?.stk === STK_PARAGRAPH)
			out.push(val("next", nextId))

		const linkId = style.istdLink !== 0 && style.istdLink !== ISTD_NIL ? map.id(style.istdLink) : undefined

		if (linkId !== undefined && linkId !== id) out.push(val("link", linkId))
		if (style.autoRedefine) out.push("<w:autoRedefine/>")
		if (style.hidden) out.push("<w:hidden/>")
		if (style.priority !== undefined && style.priority !== 0) out.push(val("uiPriority", Math.min(99, style.priority)))
		if (style.semiHidden) out.push("<w:semiHidden/>")
		if (style.unhideWhenUsed) out.push("<w:unhideWhenUsed/>")
		if (style.qFormat || style.sti <= 9) out.push("<w:qFormat/>")
		if (style.locked) out.push("<w:locked/>")

		const own = resolver.resolve(istd)
		const base = baseIstd !== undefined && sameKind && baseId !== undefined ? resolver.resolve(baseIstd) : undefined
		const basePara = base?.para ?? defaultPara()
		const baseChar = base?.char ?? defaults

		if (style.stk === STK_PARAGRAPH || style.stk === STK_TABLE || style.stk === STK_NUMBERING) {
			// A list the style names (only one numbering.xml has), or numId 0 where it turns its base's list off.
			const numId = (ilfo: number): number => (ilfo > 0 && numIds.has(ilfo) ? ilfo : 0)
			const ownList = numId(own.para.ilfo)
			const inherited = numId(basePara.ilfo)
			const numbering =
				ownList !== inherited || (ownList > 0 && own.para.ilvl !== basePara.ilvl)
					? { numbering: { numId: ownList, ilvl: ownList > 0 ? Math.min(8, own.para.ilvl) : 0 } }
					: {}
			const ppr = paragraphProperties(own.para, basePara, context, numbering)

			if (ppr !== "") out.push(`<w:pPr>${ppr}</w:pPr>`)
		}

		if (style.stk !== STK_NUMBERING) {
			const rpr = runProperties(own.char, baseChar, context)

			if (rpr !== "") out.push(`<w:rPr>${rpr}</w:rPr>`)
		}

		out.push("</w:style>")
	})

	out.push("</w:styles>")

	return out.join("")
}
