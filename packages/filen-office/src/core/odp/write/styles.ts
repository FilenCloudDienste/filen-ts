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
	type SourceRef,
	type Xfrm
} from "../../presentation/model"
import { decodeUtf8, escapeAttribute, escapeText, type Namespaces, type XmlDocument } from "../../xml/index"
import type { Fragment, OdpContext } from "../read/context"
import type { OdpParts } from "../read/document"
import { EMU_PER_PT } from "../read/fills"
import type { OdpEmitContext, OdpStylesApi } from "./emit"
import type { DrawResourceSink } from "./resources"
import type { DeckOpFamily } from "../../presentation/edit/ops"
import type { EmitRequest, EmitResult } from "../../pptx/write/types"
import { isRefused } from "../../presentation/refusal"

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

// The attributes a fill is written in (§20.137 draw:fill and those it brings: §20.146 draw:fill-color, §20.144
// draw:opacity, the drawing resources a fill names, §20.142 draw:fill-image-*…).
export const FILL_PROPERTIES = [
	"draw:fill",
	"draw:fill-color",
	"draw:opacity",
	"draw:opacity-name",
	"draw:fill-gradient-name",
	"draw:gradient-step-count",
	"draw:fill-hatch-name",
	"draw:fill-hatch-solid",
	"draw:fill-image-name",
	"draw:fill-image-width",
	"draw:fill-image-height",
	"draw:fill-image-ref-point",
	"draw:fill-image-ref-point-x",
	"draw:fill-image-ref-point-y",
	"draw:tile-repeat-offset",
	"style:repeat"
] as const

// The attributes a line is written in (§20.163 draw:stroke and those it brings).
const LINE_PROPERTIES = [
	"draw:stroke",
	"draw:stroke-dash",
	"svg:stroke-width",
	"svg:stroke-color",
	"svg:stroke-opacity",
	"svg:stroke-linecap",
	"draw:stroke-linejoin",
	"draw:marker-start",
	"draw:marker-start-width",
	"draw:marker-end",
	"draw:marker-end-width"
] as const

// A fill (§20.137 draw:fill …): solid and none are written; a fill that needs a drawing resource (gradient, hatch,
// bitmap) is refused when it is new, so nothing is dropped. The inherited one (no fill of the shape's own): its own
// fill attributes taken out, so its style chain gives it (a notes body a session made, written without one, then
// put back by an undo from the markup a save wrote for it).
export function fillChanges(changes: StyleChanges, fill: FillProps | "none" | undefined): Refused | undefined {
	if (fill === undefined) {
		for (const name of FILL_PROPERTIES) setProperty(changes, "graphic", name, null)

		return undefined
	}

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
	// The inherited one: its own line attributes taken out (as an inherited fill).
	if (line === undefined) {
		for (const name of LINE_PROPERTIES) setProperty(changes, "graphic", name, null)

		return undefined
	}

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
// `frame`: the body is a text frame's (draw:frame), whose text LibreOffice wraps whatever fo:wrap-option says unless
// the frame grows with it (read/shapes.ts wrapOf): its wrap is written as draw:auto-grow-width, the option left as it was.
export function bodyChanges(changes: StyleChanges, body: Partial<TextBodyProps>, frame = false): Refused | undefined {
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
	if (body.wrap !== undefined)
		setProperty(
			changes,
			"graphic",
			frame ? "draw:auto-grow-width" : "fo:wrap-option",
			frame ? String(!body.wrap) : body.wrap ? "wrap" : "no-wrap"
		)
	// A frame that grows with its text grows about its middle unless its text area is left-aligned (LibreOffice 7.5,
	// measured: with "justify" a line runs out on both sides): left, so its line runs on to the right as a:bodyPr
	// wrap="none" draws it.
	if (frame && body.wrap === false && body.anchorCenter !== true)
		setProperty(changes, "graphic", "draw:textarea-horizontal-align", "left")

	if (body.vertical !== undefined) {
		const mode = WRITING[body.vertical]

		if (mode === undefined) return refused("unsupported", `vertical ${body.vertical}`)

		setProperty(changes, "graphic", "style:writing-mode", mode)
		setProperty(changes, "paragraph", "style:writing-mode", mode)
	}

	if (body.autofit !== undefined) {
		setProperty(changes, "graphic", "draw:auto-grow-height", body.autofit === "shape" ? "true" : "false")
		// Fitting its text, a shape has no least height of its own (§20.186 fo:min-height).
		setProperty(changes, "graphic", "fo:min-height", body.autofit === "shape" ? "0cm" : null)
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

	// One size for every script (§21.1.2.3.9 sz); ODF sizes East Asian and complex text apart (§20.284, §20.285).
	if (rPr.sz !== undefined) {
		const size = pt(rPr.sz / 100)

		out.set("fo:font-size", size).set("style:font-size-asian", size).set("style:font-size-complex", size)
	}

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

// The order of style:*-properties elements in a style (§16.2: graphic, paragraph, text for graphic styles; table-cell,
// paragraph, text for table-cell styles).
const KIND_ORDER = ["graphic", "loext:graphic", "drawing-page", "table-cell", "paragraph", "text", "table", "table-column", "table-row"]

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
// every value of an attribute whose local name ends in "style-name", double-quoted, as written.
export function referencedNames(bytes: Uint8Array, into: Set<string>): void {
	attributeValues(bytes, STYLE_NAMES, false, (start, end) => {
		into.add(decodeUtf8(bytes, start, end))
	})
}

// Every value of an attribute whose name ends in one of `suffixes`, by a byte scan in time linear in the stream: each
// `suffix="` (and `suffix='` when `single`) and the bytes up to the next same quote, the value's span handed to `visit`.
// It reads as the expression /[\w.-]*(?:suffix|…)=(?:"([^"]*)"|'([^']*)')/ reads, without its backtracking: a quote is
// ASCII, so no character straddles a value's ends, and the scan goes on after the closing quote, as a match does.
export function attributeValues(
	bytes: Uint8Array,
	suffixes: readonly Uint8Array[],
	single: boolean,
	visit: (start: number, end: number) => void
): void {
	// A quote kind found unclosed: no later value of that kind closes either (the other kind still may), so it is not
	// looked for again (looking would make the scan quadratic).
	let doubleOpen = true
	let singleOpen = single

	for (let at = bytes.indexOf(EQUALS); at >= 0; at = bytes.indexOf(EQUALS, at + 1)) {
		const quote = bytes[at + 1]

		if (!(quote === QUOTE ? doubleOpen : quote === APOSTROPHE && singleOpen)) continue
		if (!suffixes.some(suffix => endsAt(bytes, at, suffix))) continue

		const close = bytes.indexOf(quote === QUOTE ? QUOTE : APOSTROPHE, at + 2)

		if (close < 0) {
			if (quote === QUOTE) doubleOpen = false
			else singleOpen = false

			continue
		}

		visit(at + 2, close)
		at = close
	}
}

function endsAt(bytes: Uint8Array, end: number, suffix: Uint8Array): boolean {
	if (end < suffix.length) return false

	for (let k = 0; k < suffix.length; k++) if (bytes[end - suffix.length + k] !== suffix[k]) return false

	return true
}

const asBytes = (text: string): Uint8Array => Uint8Array.from(text, character => character.charCodeAt(0))

export const STYLE_NAME_SUFFIX = asBytes("style-name")
export const MASTER_PAGE_NAME_SUFFIX = asBytes("master-page-name")
const STYLE_NAMES = [STYLE_NAME_SUFFIX]
const EQUALS = 0x3d
const QUOTE = 0x22
const APOSTROPHE = 0x27

// The names of each reading's streams, read once: a reading's streams never change (a save's rebase opens a new
// reading, whose content bytes are another array), so every page's proof and every save copies them instead of
// scanning the whole content stream again.
const takenCache = new WeakMap<Uint8Array, { readonly styles: object | undefined; readonly names: ReadonlySet<string> }>()

// Every name a new automatic style of a save must not take: the styles both streams define and every style name
// their markup refers to. A set of the caller's own (it adds to it).
export function takenInStreams(parts: OdpParts): Set<string> {
	const held = takenCache.get(parts.content.bytes)

	if (held !== undefined && held.styles === parts.sheet.stylesDocument) return new Set(held.names)

	const taken = scanTaken(parts)

	takenCache.set(parts.content.bytes, { styles: parts.sheet.stylesDocument, names: taken })

	return new Set(taken)
}

function scanTaken(parts: OdpParts): Set<string> {
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
	// The boxes of presentation objects a save marked user-transformed (OdpWriteSource.placeholderBoxes), when the
	// writer edits a source.
	readonly placeholderBoxes?: Map<string, Xfrm>
	// The mirror values a save first changed (OdpWriteSource.mirrorValues).
	readonly mirrorValues?: Map<string, string | undefined>
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
	table: OdfNs.table,
	anim: OdfNs.anim,
	smil: OdfNs.smil
}

// New markup with declarations on its first start tag for each prefix it writes that `scope` (prefix → URI, the
// namespaces in scope where it goes) does not bind to the same namespace.
export function declared(markup: string, scope: ReadonlyMap<string, string>): string {
	const end = markup.search(/[\s/>]/u)
	const unbound = unboundPrefixes(markup, scope)
	let extra = ""

	for (const [prefix, uri] of Object.entries(WRITTEN_NAMESPACES))
		if (unbound.has(prefix)) extra += ` xmlns:${prefix}="${escapeAttribute(uri)}"`

	return extra === "" || end < 0 ? markup : markup.slice(0, end) + extra + markup.slice(end)
}

const ATTRIBUTE = /\s+([^\s=]+)\s*=\s*(?:"[^"]*"|'[^']*')/gy

// The prefixes markup uses (element and attribute names) that neither `scope` nor an enclosing element of the markup
// itself declares: markup copied with its own declarations (an object's xmlns:xlink) needs none added.
function unboundPrefixes(markup: string, scope: ReadonlyMap<string, string>): Set<string> {
	const out = new Set<string>()
	const stack: string[][] = []
	const bound = (prefix: string): boolean => scope.has(prefix) || stack.some(level => level.includes(prefix))

	for (const match of markup.matchAll(/<(\/?)([A-Za-z_][\w.-]*(?::[\w.-]+)?)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/gu)) {
		if (match[1] === "/") {
			stack.pop()
			continue
		}

		const declares: string[] = []
		const used: string[] = []
		const name = match[2] ?? ""

		if (name.includes(":")) used.push(name.slice(0, name.indexOf(":")))

		// Attribute by attribute from where the last ended (sticky): a scan for names at every position would also read
		// names inside values, and take time quadratic in a long value.
		for (const attribute of (match[3] ?? "").matchAll(ATTRIBUTE)) {
			const attributeName = attribute[1] ?? ""

			if (attributeName.startsWith("xmlns:")) declares.push(attributeName.slice(6))
			else if (attributeName.includes(":")) used.push(attributeName.slice(0, attributeName.indexOf(":")))
		}

		stack.push(declares)

		for (const prefix of used) if (prefix !== "xml" && !bound(prefix)) out.add(prefix)

		if (match[4] === "/") stack.pop()
	}

	return out
}

// The declarations a style element needs in a stream whose root binds `scope`.
export function styleDeclarations(scope: ReadonlyMap<string, string>): string {
	let out = ""

	for (const prefix of ["style", "fo", "draw", "svg", "text", "presentation", "loext", "table", "xlink", "smil"]) {
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
	private readonly replacedEntries: { readonly path: string; readonly content: PartBytes }[] = []
	// Where a writer of new office:styles puts drawing resources (gradients, markers…, resources.ts); a save of a
	// source has none, and refuses what needs one.
	resources: DrawResourceSink | undefined = undefined

	// The declarations every new style element carries (the prefixes the stream's root does not bind as written).
	private readonly declarations: string

	constructor(env: OdpWriteEnv, scope: StyleScope, taken: Set<string>, declarations = "") {
		this.env = env
		this.sheet = env.context.sheet
		this.scope = scope
		this.declarations = declarations
		this.registry = new StyleRegistry(taken, declarations)
	}

	// Styles a save retired, by family and written form: a style written again with the same form takes the retired
	// name back (the save puts its definition back where it was), so the same state saves to the same bytes.
	reuseRetired(retired: ReadonlyMap<string, string>): void {
		if (retired.size === 0) return

		const byFamily = new Map<string, Map<string, string>>()

		for (const [name, markup] of retired) {
			// Its name and family in either order (LibreOffice writes the name first, Google's export the family), the
			// other attributes in theirs.
			const match = /^<style:style((?:\s+[\w:-]+="[^"]*")*)(?:\/>|>([\s\S]*)<\/style:style>)\s*$/u.exec(markup)

			if (match === null) continue

			let own: string | undefined
			let family: string | undefined
			let rest = ""

			for (const attribute of (match[1] ?? "").matchAll(/\s+([\w:-]+)="([^"]*)"/gu)) {
				const [whole, key, value] = attribute

				if (key === "style:name") own = value
				else if (key === "style:family") family = value
				else if (!key?.startsWith("xmlns:")) rest += whole
			}

			if (own !== escapeAttribute(name) || family === undefined) continue

			let forms = byFamily.get(family)

			if (forms === undefined) {
				forms = new Map()
				byFamily.set(family, forms)
			}

			const form = `${rest}\u0000${match[2] ?? ""}`

			if (!forms.has(form)) forms.set(form, name)
		}

		const empty: ReadonlyMap<string, string> = new Map()

		this.registry.existing = family => byFamily.get(family) ?? empty
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

	// A source entry's bytes replaced whole (a chart object's content.xml written again); false, changing nothing, when
	// the package has no such entry.
	replaceEntry(path: string, content: PartBytes): boolean {
		if (!this.env.context.hasPart(path)) return false

		const at = this.replacedEntries.findIndex(entry => entry.path === path)

		if (at >= 0) this.replacedEntries[at] = { path, content }
		else this.replacedEntries.push({ path, content })

		return true
	}

	replaced(): readonly { readonly path: string; readonly content: PartBytes }[] {
		return this.replacedEntries
	}

	// A new style of `family` whose own properties are `base`'s (an automatic style is copied whole with its parent; a
	// common one becomes the parent) with `changes` applied; undefined `base`: a style of the changes alone. `named`:
	// style attributes set on the copy (a style:list-style-name renamed).
	derived(
		family: string,
		base: string | undefined,
		changes: StyleChanges,
		extra: string = "",
		named: ReadonlyMap<string, string> = new Map()
	): string {
		const style = base === undefined ? undefined : this.sheet.style(family, base, this.scope)
		const automatic = style?.automatic === true
		const own: ReadonlyMap<string, OdfProperties> = automatic ? style.properties : new Map()
		const parent = automatic ? style.parent : style === undefined ? undefined : base
		const attributes = new Map<string, string>(automatic ? style.attributes : [])

		attributes.delete("style:name")
		attributes.delete("style:family")
		attributes.delete("style:parent-style-name")

		if (parent !== undefined) attributes.set("style:parent-style-name", parent)

		for (const [name, value] of named) attributes.set(name, value)

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
