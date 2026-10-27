import {
	OdfNs,
	readContentPrologue,
	type OdfElement,
	type OdfProperties,
	type OdfStyle,
	type OdfStyleSheet,
	type StyleScope
} from "../../odf/index"
import type { PartBytes } from "../../opc/index"
import { StyleRegistry } from "../../odt/write/emit"
import type { TextBodyProps } from "../../drawingml/index"
import {
	refused,
	type ColorModel,
	type EffectList,
	type FillProps,
	type LineProps,
	type ParaProps,
	type Refused,
	type RunProps,
	type SlideRef,
	type SourceRef
} from "../../presentation/model"
import { decodeUtf8, escapeAttribute, escapeText, type Namespaces, type XmlDocument } from "../../xml/index"
import type { Fragment, OdpContext } from "../read/context"
import type { OdpParts } from "../read/document"
import { EMU_PER_PT } from "../read/fills"
import type { OdpEmitContext, OdpStylesApi } from "./emit"
import type { DeckOpFamily } from "../../presentation/edit/ops"
import type { EmitRequest, EmitResult } from "../../pptx/write/types"

// The automatic styles a save writes (ODF 1.3 Part 3 §16.2): a shape's, paragraph's or span's properties as
// style:*-properties attributes, the inverse of the reader's mapping (read/fills.ts, read/text.ts), so what is written
// reads back as the model holds it. A style the shape already had is patched rather than replaced: the new automatic
// style copies the old one's own attributes and properties and changes only what the edit changed, so everything the
// model does not carry (an ODF-only property, a foreign attribute) is kept. New names never collide with any name
// either stream uses, and only styles something written names are emitted.

export const EMU_PER_CM = 360_000
const PX_PER_PT = 96 / 72

// Lengths written with enough digits that the reader rounds them back to the same EMU.
function decimal(value: number, digits: number): string {
	const fixed = value.toFixed(digits)
	const trimmed = fixed.includes(".") ? fixed.replace(/0+$/u, "").replace(/\.$/u, "") : fixed

	return trimmed === "-0" ? "0" : trimmed
}

export function cm(emu: number): string {
	return `${decimal(emu / EMU_PER_CM, 6)}cm`
}

export function pt(points: number): string {
	return `${decimal(points, 4)}pt`
}

export function percent(value: number): string {
	return `${decimal(value, 3)}%`
}

export function hexColor(color: ColorModel): string | Refused {
	if (color.kind !== "srgb") return refused("unsupported", `colour ${color.kind}`)

	const other = color.mods?.find(mod => mod.name !== "alpha")

	if (other !== undefined) return refused("unsupported", `colour modifier ${other.name}`)

	return `#${color.rgb.toLowerCase()}`
}

// The alpha of an sRGB colour as 1/100,000 (100,000 when opaque).
export function alphaOf(color: ColorModel): number {
	return color.mods?.find(mod => mod.name === "alpha")?.value ?? 100_000
}

export function isRefused(value: unknown): value is Refused {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "refused"
}

// Attribute changes of one properties element: a value to write, or null to take the attribute out.
export type PropertyChanges = Map<string, string | null>

// Changes by properties kind ("graphic", "paragraph", "text"), plus child elements replaced whole by name.
export interface StyleChanges {
	readonly attributes: Map<string, PropertyChanges>
	readonly children: Map<string, Map<string, string | null>>
}

export function styleChanges(): StyleChanges {
	return { attributes: new Map(), children: new Map() }
}

export function setProperty(changes: StyleChanges, kind: string, name: string, value: string | null): void {
	let held = changes.attributes.get(kind)

	if (held === undefined) {
		held = new Map()
		changes.attributes.set(kind, held)
	}

	held.set(name, value)
}

export function setChild(changes: StyleChanges, kind: string, name: string, markup: string | null): void {
	let held = changes.children.get(kind)

	if (held === undefined) {
		held = new Map()
		changes.children.set(kind, held)
	}

	held.set(name, markup)
}

// --- Properties written from the model (the reader's mapping, inverted). ---

// A fill (§20.137 draw:fill …): solid and none are written; a fill that needs a drawing resource (gradient, hatch,
// bitmap) is refused when it is new, so nothing is dropped.
export function fillChanges(changes: StyleChanges, fill: FillProps | "none" | undefined): Refused | undefined {
	if (fill === undefined) return refused("unsupported", "a fill taken back to the inherited one")

	if (fill === "none") {
		setProperty(changes, "graphic", "draw:fill", "none")

		return undefined
	}

	if (fill.kind !== "solid") return refused("unsupported", `${fill.kind} fill`)

	const color = hexColor(fill.color)

	if (isRefused(color)) return color

	setProperty(changes, "graphic", "draw:fill", "solid")
	setProperty(changes, "graphic", "draw:fill-color", color)
	setProperty(changes, "graphic", "draw:opacity", percent(alphaOf(fill.color) / 1000))
	setProperty(changes, "graphic", "draw:transparency", null)

	return undefined
}

const CAPS: Readonly<Record<string, string>> = { flat: "butt", rnd: "round", sq: "square" }

// A line (§20.164 draw:stroke …): none, or a solid line of a width and colour with its caps and joins. Ends and
// dashes need drawing resources: they must be the ones the source already names (`kept`), else refused.
export function lineChanges(
	changes: StyleChanges,
	line: LineProps | "none" | undefined,
	kept: LineProps | "none" | undefined
): Refused | undefined {
	if (line === undefined) return refused("unsupported", "a line taken back to the inherited one")

	if (line === "none") {
		setProperty(changes, "graphic", "draw:stroke", "none")

		return undefined
	}

	const before = kept === "none" ? undefined : kept
	const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

	if (!same(line.head, before?.head) || !same(line.tail, before?.tail)) return refused("unsupported", "new line ends")
	if (line.dash !== undefined && line.dash !== "solid") return refused("unsupported", `dash ${line.dash}`)
	if (line.custDash !== undefined && !same([...line.custDash], [...(before?.custDash ?? [])])) return refused("unsupported", "new dash")
	if (line.compound !== undefined && line.compound !== "sng") return refused("unsupported", `compound ${line.compound}`)

	const fill = line.fill ?? (before?.fill === "none" ? undefined : before?.fill)

	if (fill === "none") {
		setProperty(changes, "graphic", "draw:stroke", "none")

		return undefined
	}

	if (fill !== undefined && fill.kind !== "solid") return refused("unsupported", `${fill.kind} line`)

	if (line.custDash === undefined) setProperty(changes, "graphic", "draw:stroke", "solid")
	if (line.w !== undefined) setProperty(changes, "graphic", "svg:stroke-width", cm(line.w))

	if (fill !== undefined) {
		const color = hexColor(fill.color)

		if (isRefused(color)) return color

		setProperty(changes, "graphic", "svg:stroke-color", color)
		setProperty(changes, "graphic", "svg:stroke-opacity", percent(alphaOf(fill.color) / 1000))
	}

	if (line.cap !== undefined) setProperty(changes, "graphic", "svg:stroke-linecap", CAPS[line.cap] ?? "butt")
	if (line.join !== undefined) setProperty(changes, "graphic", "draw:stroke-linejoin", line.join)

	return undefined
}

// A shadow (§20.299): the reader's one outer shadow, or none.
export function effectChanges(changes: StyleChanges, effects: EffectList | undefined): Refused | undefined {
	const list = effects?.effects ?? []

	if (list.length === 0) {
		setProperty(changes, "graphic", "draw:shadow", "hidden")

		return undefined
	}

	const effect = list[0]

	if (list.length > 1 || effect?.kind !== "outerShdw") return refused("unsupported", "effects other than one outer shadow")
	if ((effect.sx !== undefined && effect.sx !== 100_000) || (effect.sy !== undefined && effect.sy !== 100_000))
		return refused("unsupported", "a scaled shadow")

	const color = hexColor(effect.color)

	if (isRefused(color)) return color

	const radians = (effect.dir / 60_000) * (Math.PI / 180)
	const points = effect.dist / EMU_PER_PT

	setProperty(changes, "graphic", "draw:shadow", "visible")
	setProperty(changes, "graphic", "draw:shadow-offset-x", cm(Math.cos(radians) * points * EMU_PER_PT))
	setProperty(changes, "graphic", "draw:shadow-offset-y", cm(Math.sin(radians) * points * EMU_PER_PT))
	setProperty(changes, "graphic", "draw:shadow-color", color)
	setProperty(changes, "graphic", "draw:shadow-opacity", percent(alphaOf(effect.color) / 1000))
	setProperty(changes, "graphic", "loext:shadow-blur", cm(effect.blurRad))

	return undefined
}

const ANCHORS: Readonly<Record<string, string>> = { t: "top", ctr: "middle", b: "bottom", just: "justify" }
const WRITING: Readonly<Record<string, string>> = { horz: "lr-tb", vert: "tb-rl", vert270: "tb-lr" }

// A text area (§20.130, §20.218, §20.119, §20.393, §20.394; style:columns §17.12).
export function bodyChanges(changes: StyleChanges, body: Partial<TextBodyProps>): Refused | undefined {
	if (body.insets !== undefined) {
		// A padding is a non-negative length (§20.218).
		for (const [side, value] of Object.entries(body.insets))
			setProperty(changes, "graphic", `fo:padding-${side}`, pt(Number.isFinite(value) && value > 0 ? value / PX_PER_PT : 0))

		setProperty(changes, "graphic", "fo:padding", null)
	}

	if (body.anchor !== undefined) {
		const anchor = ANCHORS[body.anchor]

		if (anchor === undefined) return refused("unsupported", `anchor ${body.anchor}`)

		setProperty(changes, "graphic", "draw:textarea-vertical-align", anchor)
	}

	if (body.anchorCenter !== undefined)
		setProperty(changes, "graphic", "draw:textarea-horizontal-align", body.anchorCenter ? "center" : "justify")
	if (body.wrap !== undefined) setProperty(changes, "graphic", "fo:wrap-option", body.wrap ? "wrap" : "no-wrap")

	if (body.vertical !== undefined) {
		const mode = WRITING[body.vertical]

		if (mode === undefined) return refused("unsupported", `vertical ${body.vertical}`)

		setProperty(changes, "graphic", "style:writing-mode", mode)
		setProperty(changes, "paragraph", "style:writing-mode", mode)
	}

	if (body.autofit !== undefined) {
		setProperty(changes, "graphic", "draw:auto-grow-height", body.autofit === "shape" ? "true" : "false")
		setProperty(changes, "graphic", "style:shrink-to-fit", body.autofit === "normal" ? "true" : "false")
		setProperty(changes, "graphic", "draw:fit-to-size", "false")
	}

	if (body.columns !== undefined) {
		setChild(
			changes,
			"graphic",
			"style:columns",
			body.columns > 1
				? `<style:columns fo:column-count="${String(body.columns)}" fo:column-gap="${pt((body.columns > 1 ? (body.columnSpacing ?? 0) : 0) / PX_PER_PT)}"/>`
				: null
		)
	}

	if (body.rotation !== undefined && body.rotation !== 0) return refused("unsupported", "rotated text")
	if (body.upright === true) return refused("unsupported", "upright text")

	return undefined
}

const UNDERLINES: Readonly<Record<string, readonly [string, string | undefined, string | undefined]>> = {
	none: ["none", undefined, undefined],
	sng: ["solid", undefined, undefined],
	dbl: ["solid", undefined, "double"],
	heavy: ["solid", "bold", undefined],
	dotted: ["dotted", undefined, undefined],
	dottedHeavy: ["dotted", "bold", undefined],
	dash: ["dash", undefined, undefined],
	dashHeavy: ["dash", "bold", undefined],
	dashLong: ["long-dash", undefined, undefined],
	dashLongHeavy: ["long-dash", "bold", undefined],
	dotDash: ["dot-dash", undefined, undefined],
	dotDashHeavy: ["dot-dash", "bold", undefined],
	dotDotDash: ["dot-dot-dash", undefined, undefined],
	dotDotDashHeavy: ["dot-dot-dash", "bold", undefined],
	wavy: ["wave", undefined, undefined],
	wavyHeavy: ["wave", "bold", undefined],
	wavyDbl: ["wave", undefined, "double"]
}

function family(name: string): string {
	return /[\s,'"]/u.test(name) ? `'${name.replace(/'/gu, "")}'` : name
}

const UNWRITTEN_RUN: readonly (keyof RunProps)[] = ["kern", "altLang", "sym", "ln", "effects", "uLn", "uFill", "hlinkMouseOver"]

// style:text-properties (§16.27.28) for the run properties `rPr` holds (the reader's runPropsOf, inverted). Hyperlinks
// are text:a, not properties.
export function runAttributes(rPr: RunProps): Map<string, string> | Refused {
	const out = new Map<string, string>()

	for (const key of UNWRITTEN_RUN) if (rPr[key] !== undefined) return refused("unsupported", `run property ${key}`)

	if (rPr.sz !== undefined) out.set("fo:font-size", pt(rPr.sz / 100))

	if (rPr.b !== undefined) {
		const weight = rPr.b ? "bold" : "normal"

		out.set("fo:font-weight", weight).set("style:font-weight-asian", weight).set("style:font-weight-complex", weight)
	}

	if (rPr.i !== undefined) {
		const style = rPr.i ? "italic" : "normal"

		out.set("fo:font-style", style).set("style:font-style-asian", style).set("style:font-style-complex", style)
	}

	if (rPr.u !== undefined) {
		const underline = UNDERLINES[rPr.u]

		if (underline === undefined) return refused("unsupported", `underline ${rPr.u}`)

		out.set("style:text-underline-style", underline[0])

		if (rPr.u !== "none") {
			out.set("style:text-underline-width", underline[1] ?? "auto")
			out.set("style:text-underline-color", "font-color")
			if (underline[2] !== undefined) out.set("style:text-underline-type", underline[2])
		}
	}

	if (rPr.strike !== undefined) {
		out.set("style:text-line-through-style", rPr.strike === "noStrike" ? "none" : "solid")
		if (rPr.strike === "dblStrike") out.set("style:text-line-through-type", "double")
	}

	if (rPr.baseline !== undefined) out.set("style:text-position", rPr.baseline === 0 ? "0% 100%" : `${percent(rPr.baseline / 1000)} 58%`)

	if (rPr.cap === "all") out.set("fo:text-transform", "uppercase")
	else if (rPr.cap === "small") out.set("fo:font-variant", "small-caps")
	else if (rPr.cap === "none") out.set("fo:text-transform", "none").set("fo:font-variant", "normal")

	if (rPr.spc !== undefined) out.set("fo:letter-spacing", rPr.spc === 0 ? "normal" : pt(rPr.spc / 100))

	if (rPr.lang !== undefined) {
		// fo:language and fo:country (§20.193, §20.174): a language and a region; a tag of another shape is refused.
		const match = /^([A-Za-z]{1,8})(?:-([A-Za-z0-9]{1,8}))?$/u.exec(rPr.lang)

		if (match === null) return refused("unsupported", `language ${rPr.lang}`)

		out.set("fo:language", match[1] ?? "none").set("fo:country", match[2] ?? "none")
	}

	if (rPr.latin !== undefined) out.set("fo:font-family", family(rPr.latin.typeface))
	if (rPr.ea !== undefined) out.set("style:font-family-asian", family(rPr.ea.typeface))
	if (rPr.cs !== undefined) out.set("style:font-family-complex", family(rPr.cs.typeface))

	if (rPr.fill !== undefined) {
		if (rPr.fill === "none" || rPr.fill.kind !== "solid") return refused("unsupported", "a text fill that is not one colour")

		const color = hexColor(rPr.fill.color)

		if (isRefused(color)) return color
		if (alphaOf(rPr.fill.color) !== 100_000) return refused("unsupported", "transparent text")

		out.set("fo:color", color)
	}

	if (rPr.highlight !== undefined) {
		const color = hexColor(rPr.highlight)

		if (isRefused(color)) return color

		out.set("fo:background-color", color)
	}

	return out
}

const ALIGNS: Readonly<Record<string, string>> = { l: "start", ctr: "center", r: "end", just: "justify" }
const UNWRITTEN_PARAGRAPH: readonly (keyof ParaProps)[] = ["fontAlgn", "eaLnBrk", "latinLnBrk", "hangingPunct", "defRPr"]

// style:paragraph-properties (§17.6) for a paragraph's own properties (the reader's paraPropsOf, inverted); the list
// fields (lvl, bullet and its colour, size and font) are the list's. `marL` is the paragraph's own margin.
export function paragraphAttributes(
	pPr: ParaProps,
	marL: number | undefined
): { attributes: Map<string, string>; tabs?: string } | Refused {
	const out = new Map<string, string>()

	for (const key of UNWRITTEN_PARAGRAPH) if (pPr[key] !== undefined) return refused("unsupported", `paragraph property ${key}`)

	if (pPr.algn !== undefined) {
		const align = ALIGNS[pPr.algn]

		if (align === undefined) return refused("unsupported", `alignment ${pPr.algn}`)

		out.set("fo:text-align", align)
	}

	if (marL !== undefined) out.set("fo:margin-left", cm(marL))
	if (pPr.marR !== undefined) out.set("fo:margin-right", cm(pPr.marR))
	if (pPr.indent !== undefined) out.set("fo:text-indent", cm(pPr.indent))

	if (pPr.lnSpc !== undefined) out.set("fo:line-height", "pct" in pPr.lnSpc ? percent(pPr.lnSpc.pct / 1000) : pt(pPr.lnSpc.pts / 100))

	for (const [name, spacing] of [
		["fo:margin-top", pPr.spcBef],
		["fo:margin-bottom", pPr.spcAft]
	] as const) {
		if (spacing === undefined) continue
		if ("pct" in spacing) return refused("unsupported", "spacing in percent of a line")

		out.set(name, pt(spacing.pts / 100))
	}

	if (pPr.rtl !== undefined) out.set("style:writing-mode", pPr.rtl ? "rl-tb" : "lr-tb")
	if (pPr.defTabSz !== undefined) out.set("style:tab-stop-distance", cm(pPr.defTabSz))
	if (pPr.fontIndependentLineSpacing !== undefined)
		out.set("style:font-independent-line-spacing", pPr.fontIndependentLineSpacing ? "true" : "false")

	if (pPr.tabs === undefined) return { attributes: out }

	// The reader adds the paragraph's left margin to each stop (§19.877 positions are from the margin).
	const types: Readonly<Record<string, string>> = { l: "left", ctr: "center", r: "right", dec: "char" }
	const stops = pPr.tabs
		.map(
			tab =>
				`<style:tab-stop style:position="${cm(tab.pos - (marL ?? 0))}" style:type="${types[tab.algn] ?? "left"}"${tab.algn === "dec" ? ' style:char="."' : ""}/>`
		)
		.join("")

	return { attributes: out, tabs: `<style:tab-stops>${stops}</style:tab-stops>` }
}

// --- Serializing styles. ---

export function attributeMarkup(attributes: Iterable<readonly [string, string]>): string {
	let out = ""

	for (const [name, value] of attributes) {
		// A name the canonical table has no prefix for ("{uri}local") is never written by us: such styles are kept.
		if (name.startsWith("{")) continue

		out += ` ${name}="${escapeAttribute(value)}"`
	}

	return out
}

export function elementMarkup(element: OdfElement): string {
	const attributes = attributeMarkup(element.attributes)
	const inner = element.children.map(elementMarkup).join("") + escapeText(element.text)

	return inner === "" ? `<${element.name}${attributes}/>` : `<${element.name}${attributes}>${inner}</${element.name}>`
}

function propertiesMarkup(kind: string, properties: OdfProperties, changes: StyleChanges): string {
	const attributes = new Map(properties.attributes)

	for (const [name, value] of changes.attributes.get(kind) ?? []) {
		if (value === null) attributes.delete(name)
		else attributes.set(name, value)
	}

	const replaced = changes.children.get(kind)
	const children = properties.children.filter(child => !replaced?.has(child.name)).map(elementMarkup)

	for (const markup of replaced?.values() ?? []) if (markup !== null) children.push(markup)

	if (attributes.size === 0 && children.length === 0) return ""

	const name = kind.includes(":") ? `${kind}-properties` : `style:${kind}-properties`
	const inner = children.join("")

	return inner === "" ? `<${name}${attributeMarkup(attributes)}/>` : `<${name}${attributeMarkup(attributes)}>${inner}</${name}>`
}

// The order of style:*-properties elements in a style (§16.2: graphic, paragraph, text for graphic styles).
const KIND_ORDER = ["graphic", "loext:graphic", "drawing-page", "paragraph", "text", "table-cell", "table", "table-column", "table-row"]

function kindsOf(own: ReadonlyMap<string, OdfProperties>, changes: StyleChanges): string[] {
	const kinds = new Set([...own.keys(), ...changes.attributes.keys(), ...changes.children.keys()])

	return [...kinds].sort((a, b) => ((KIND_ORDER.indexOf(a) + 100) % 100) - ((KIND_ORDER.indexOf(b) + 100) % 100))
}

// A name the stream holds anywhere a style:name, draw:name of a resource or a list style may be: every attribute
// named "style:name" or "draw:name" under the style containers.
export function takenNames(
	documents: readonly { readonly document: XmlDocument; readonly namespaces: Namespaces; readonly root: number }[]
): Set<string> {
	const taken = new Set<string>()

	for (const { document, namespaces, root } of documents) {
		for (let section = document.firstChildElement(root); section >= 0; section = document.nextSiblingElement(section)) {
			if (namespaces.elementUri(section) !== OdfNs.office) continue

			const local = document.localName(section)

			if (local !== "automatic-styles" && local !== "styles" && local !== "master-styles") continue

			for (let style = document.firstChildElement(section); style >= 0; style = document.nextSiblingElement(style)) {
				for (const attribute of document.attributes(style)) {
					const colon = attribute.name.indexOf(":")

					if (colon > 0 && attribute.name.slice(colon + 1) === "name") taken.add(attribute.value)
				}
			}
		}
	}

	return taken
}

// Names a stream's markup refers to (style:name of nothing still names something to a reader that later finds one):
// every value of an attribute whose local name ends in "style-name", by a byte scan.
export function referencedNames(bytes: Uint8Array, into: Set<string>): void {
	const text = decodeUtf8(bytes, 0, bytes.length)

	for (const match of text.matchAll(/[\w-]*style-name="([^"]*)"/gu)) into.add(match[1] ?? "")
}

// Every name a new automatic style of a save must not take: the styles both streams define and every style name
// their markup refers to.
export function takenInStreams(parts: OdpParts): Set<string> {
	const prologue = readContentPrologue(parts.content.bytes)
	const stylesDocument = parts.sheet.stylesDocument
	const taken = takenNames([
		{ document: prologue.document, namespaces: prologue.namespaces, root: prologue.root },
		...(stylesDocument === undefined || parts.sheet.stylesNamespaces === undefined
			? []
			: [{ document: stylesDocument, namespaces: parts.sheet.stylesNamespaces, root: stylesDocument.documentElement() }])
	])

	referencedNames(parts.content.bytes, taken)

	if (stylesDocument !== undefined) referencedNames(stylesDocument.bytes, taken)

	return taken
}

const PREFIXES: Readonly<Record<string, string>> = {
	graphic: "gr",
	presentation: "pr",
	paragraph: "P",
	text: "T",
	"drawing-page": "dp",
	table: "ta",
	"table-cell": "ce",
	list: "L"
}

// What the emitters read beside the model: the reader's context (styles, list styles), the source fragment a document
// is (its offset and epoch, so a paragraph's src is known to be its), and the page names jumps are written with.
export interface OdpWriteEnv {
	readonly context: OdpContext
	// styles.xml as the reader parsed it (master pages, their presentation styles).
	readonly stylesFragment: Fragment | undefined
	fragmentOf(document: XmlDocument): Fragment | undefined
	// The fragment any source ref names (another page, held markup), for a shape copied from there.
	sourceFragment(src: SourceRef): Fragment | undefined
	// The family emit nested markup goes to (emit.ts emitOdp by emitFamilyOf): given by the writers, never imported by
	// a family (the hub imports the families).
	dispatch(family: DeckOpFamily, request: EmitRequest, context: OdpEmitContext): EmitResult
	// The family that writes a request's element (pptx/write/emit.ts emitFamilyOf).
	familyOf(request: EmitRequest): DeckOpFamily
	pageName(ref: SlideRef): string | undefined
}

// The namespaces new markup uses, by the prefixes it writes.
export const WRITTEN_NAMESPACES: Readonly<Record<string, string>> = {
	office: OdfNs.office,
	style: OdfNs.style,
	text: OdfNs.text,
	draw: OdfNs.draw,
	fo: OdfNs.fo,
	svg: OdfNs.svg,
	xlink: OdfNs.xlink,
	presentation: OdfNs.presentation,
	script: OdfNs.script,
	dom: "http://www.w3.org/2001/xml-events",
	loext: OdfNs.loext,
	table: OdfNs.table
}

// New markup with declarations on its first start tag for each prefix it writes that `scope` (prefix → URI, the
// namespaces in scope where it goes) does not bind to the same namespace.
export function declared(markup: string, scope: ReadonlyMap<string, string>): string {
	const end = markup.search(/[\s/>]/u)
	let extra = ""

	for (const [prefix, uri] of Object.entries(WRITTEN_NAMESPACES)) {
		if (!markup.includes(`${prefix}:`) || scope.get(prefix) === uri) continue

		extra += ` xmlns:${prefix}="${escapeAttribute(uri)}"`
	}

	return extra === "" || end < 0 ? markup : markup.slice(0, end) + extra + markup.slice(end)
}

// The declarations a style element needs in a stream whose root binds `scope`.
export function styleDeclarations(scope: ReadonlyMap<string, string>): string {
	let out = ""

	for (const prefix of ["style", "fo", "draw", "svg", "text", "presentation", "loext", "table", "xlink"]) {
		const uri = WRITTEN_NAMESPACES[prefix] as string

		if (scope.get(prefix) !== uri) out += ` xmlns:${prefix}="${escapeAttribute(uri)}"`
	}

	return out
}

// An entry the written pages added (a picture, a medium), with how it is stored.
export interface OdpAddedEntry {
	readonly path: string
	readonly content: PartBytes
	readonly mediaType: string
	readonly compress?: boolean
	readonly crc32?: number
}

// The automatic styles of one stream that a save adds: patched copies of styles the source has, new ones, and list
// styles; named past every name either stream uses, deduplicated by what they say.
export class OdpStyles implements OdpStylesApi {
	readonly sheet: OdfStyleSheet
	readonly scope: StyleScope
	readonly env: OdpWriteEnv
	private readonly registry: StyleRegistry
	private readonly entries: OdpAddedEntry[] = []

	// The declarations every new style element carries (the prefixes the stream's root does not bind as written).
	private readonly declarations: string

	constructor(env: OdpWriteEnv, scope: StyleScope, taken: Set<string>, declarations = "") {
		this.env = env
		this.sheet = env.context.sheet
		this.scope = scope
		this.declarations = declarations
		this.registry = new StyleRegistry(taken, declarations)
	}

	automatic(family: Parameters<OdpStylesApi["automatic"]>[0], properties: string): string {
		return this.registry.style(family, PREFIXES[family] ?? "S", "", properties)
	}

	// The first entry of a path is kept (a medium or picture written once however many shapes name it).
	addEntry(
		path: string,
		content: PartBytes,
		mediaType: string,
		options: { readonly compress?: boolean; readonly crc32?: number } = {}
	): string {
		if (!this.entries.some(entry => entry.path === path)) this.entries.push({ path, content, mediaType, ...options })

		return path
	}

	added(): readonly OdpAddedEntry[] {
		return this.entries
	}

	// Whether the package written holds an entry at `path`: the source's, or one this save added.
	hasEntry(path: string): boolean {
		return this.entries.some(entry => entry.path === path) || this.env.context.hasPart(path)
	}

	// A new style of `family` whose own properties are `base`'s (an automatic style is copied whole with its parent; a
	// common one becomes the parent) with `changes` applied; undefined `base`: a style of the changes alone.
	derived(family: string, base: string | undefined, changes: StyleChanges, extra: string = ""): string {
		const style = base === undefined ? undefined : this.sheet.style(family, base, this.scope)
		const automatic = style?.automatic === true
		const own: ReadonlyMap<string, OdfProperties> = automatic ? style.properties : new Map()
		const parent = automatic ? style.parent : style === undefined ? undefined : base
		const attributes = new Map<string, string>(automatic ? style.attributes : [])

		attributes.delete("style:name")
		attributes.delete("style:family")
		attributes.delete("style:parent-style-name")

		if (parent !== undefined) attributes.set("style:parent-style-name", parent)

		const properties = kindsOf(own, changes)
			.map(kind => propertiesMarkup(kind, own.get(kind) ?? { attributes: new Map(), children: [] }, changes))
			.join("")

		return this.registry.style(family, PREFIXES[family] ?? "S", attributeMarkup(attributes) + extra, properties)
	}

	// A text:list-style (§16.30) made of the given level elements.
	list(levels: string): string {
		return this.registry.element(
			`list\u0000${levels}`,
			PREFIXES["list"] ?? "L",
			name => `<text:list-style${this.declarations} style:name="${escapeAttribute(name)}">${levels}</text:list-style>`
		)
	}

	// The style a name refers to in this stream's scope.
	style(family: string, name: string): OdfStyle | undefined {
		return this.sheet.style(family, name, this.scope)
	}

	// The styles something in `written` names (or a style kept names).
	markup(written: readonly string[]): string {
		return this.registry.markup.length === 0 ? "" : this.registry.used(written)
	}

	get empty(): boolean {
		return this.registry.markup.length === 0
	}
}

// Attributes as a sorted map key (a property set compared by what it says).
export function propertiesKey(attributes: ReadonlyMap<string, string>): string {
	return [...attributes]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, value]) => `${name}=${value}`)
		.join("\u0000")
}
