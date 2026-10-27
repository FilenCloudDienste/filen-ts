import { D, drawingGroupOf, type DrawingReader } from "../../drawingml/reader"
import type { ImageTarget } from "../../drawingml/picture"
import type { TextBodyProps } from "../../drawingml/index"
import { NodeKind, escapeAttribute, escapeText } from "../../xml/index"
import {
	PATH_ARC,
	PATH_CLOSE,
	PATH_CUBIC,
	PATH_LINE,
	PATH_MOVE,
	PATH_QUAD,
	type ColorModel,
	type EdgeFractions,
	type Effect,
	type EffectList,
	type FillProps,
	type Geometry,
	type LineEnd,
	type LineProps
} from "../model"
import type { RenderServices } from "./services"
import type { PictureAdjust } from "../edit/ops"

// The scratch document of one slide: resolved DrawingML elements written as markup, parsed once, and handed to the
// shared shape converter. Copied source groups are re-serialized with one prefix per namespace group (Strict URIs
// become their Transitional twins, which the drawing reader treats alike), so groups from parts that bind prefixes
// differently mix safely; every r:* attribute is rewritten to an id unique in the scratch document, resolved back to
// the part it came from.

const TRANSITIONAL: ReadonlyMap<D, readonly [string, string]> = new Map([
	[D.A, ["a", "http://schemas.openxmlformats.org/drawingml/2006/main"]],
	[D.P, ["p", "http://schemas.openxmlformats.org/presentationml/2006/main"]],
	[D.R, ["r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"]],
	[D.MC, ["mc", "http://schemas.openxmlformats.org/markup-compatibility/2006"]],
	[D.A14, ["a14", "http://schemas.microsoft.com/office/drawing/2010/main"]],
	[D.Asvg, ["asvg", "http://schemas.microsoft.com/office/drawing/2016/SVG/main"]],
	[D.Pic, ["pic", "http://schemas.openxmlformats.org/drawingml/2006/picture"]],
	[D.Dgm, ["dgm", "http://schemas.openxmlformats.org/drawingml/2006/diagram"]],
	[D.Dsp, ["dsp", "http://schemas.microsoft.com/office/drawing/2008/diagram"]],
	[D.C, ["c", "http://schemas.openxmlformats.org/drawingml/2006/chart"]],
	[D.P14, ["p14", "http://schemas.microsoft.com/office/powerpoint/2010/main"]],
	[D.P15, ["p15", "http://schemas.microsoft.com/office/powerpoint/2012/main"]],
	[D.P159, ["p159", "http://schemas.microsoft.com/office/powerpoint/2015/09/main"]]
])

// Element depth copied (the package budget).
export const MAX_COPY_DEPTH = 256

// Where a scratch relationship id points.
export interface ScratchRelationship {
	readonly part: string
	readonly id: string
}

export class ScratchWriter {
	private readonly services: RenderServices
	private readonly prefixes = new Map<string, string>()
	private readonly parts: string[] = []
	private nextId = 1
	private readonly relationships = new Map<string, ScratchRelationship>()
	private readonly targets = new Map<string, ImageTarget>()

	constructor(services: RenderServices) {
		this.services = services

		for (const [prefix, uri] of TRANSITIONAL.values()) this.prefixes.set(uri, prefix)
	}

	push(markup: string): void {
		this.parts.push(markup)
	}

	// A scratch id for `part`'s relationship `id`.
	relationship(part: string, id: string): string {
		const scratch = `s${String(this.nextId++)}`

		this.relationships.set(scratch, { part, id })

		return scratch
	}

	// A scratch id naming a part directly (an edited picture fill, an inserted image).
	target(partName: string): string {
		const scratch = `s${String(this.nextId++)}`

		this.targets.set(scratch, { partName, contentType: this.services.contentType(partName) })

		return scratch
	}

	// The image a scratch id resolves to: internal targets only (external ones are never fetched).
	image(scratch: string): ImageTarget | undefined {
		const direct = this.targets.get(scratch)

		if (direct !== undefined) return direct

		const source = this.relationships.get(scratch)
		const relationship = source === undefined ? undefined : this.services.relationship(source.part, source.id)

		if (relationship === undefined || relationship.external) return undefined

		return { partName: relationship.target, contentType: this.services.contentType(relationship.target) }
	}

	source(scratch: string): ScratchRelationship | undefined {
		return this.relationships.get(scratch)
	}

	private prefix(uri: string): string {
		const group = drawingGroupOf(uri)
		const known = group === D.None ? undefined : TRANSITIONAL.get(group)

		if (known !== undefined) return known[0]

		let prefix = this.prefixes.get(uri)

		if (prefix === undefined) {
			prefix = `n${String(this.prefixes.size)}`
			this.prefixes.set(uri, prefix)
		}

		return prefix
	}

	// Copies an element of `part` with its subtree; false when it is deeper than the budget (nothing written).
	copy(reader: DrawingReader, part: string, node: number): boolean {
		const out: string[] = []

		if (!this.copyInto(reader, part, node, out, 0)) return false

		this.parts.push(out.join(""))

		return true
	}

	private copyInto(reader: DrawingReader, part: string, node: number, out: string[], depth: number): boolean {
		if (depth > MAX_COPY_DEPTH) return false

		const document = reader.document
		const name = this.elementName(reader, node)

		if (name === undefined) return true

		out.push("<", name)

		let attributes: { name: string; value: string }[]

		try {
			attributes = document.attributes(node)
		} catch {
			attributes = []
		}

		for (const attribute of attributes) {
			const written = this.attributeName(reader, node, attribute.name)

			if (written === undefined) continue

			const value = written.relationship ? this.relationship(part, attribute.value) : attribute.value

			out.push(" ", written.name, '="', escapeAttribute(value), '"')
		}

		out.push(">")

		for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
			const kind = document.kinds[child]

			if (kind === NodeKind.Element) {
				if (!this.copyInto(reader, part, child, out, depth + 1)) return false
			} else if (kind === NodeKind.Text || kind === NodeKind.CData) {
				out.push(escapeText(document.text(child)))
			}
		}

		out.push("</", name, ">")

		return true
	}

	private elementName(reader: DrawingReader, node: number): string | undefined {
		const uri = reader.namespaces.elementUri(node)
		const local = reader.document.localName(node)

		return uri === undefined || uri === "" ? local : `${this.prefix(uri)}:${local}`
	}

	private attributeName(
		reader: DrawingReader,
		node: number,
		qualified: string
	): { readonly name: string; readonly relationship: boolean } | undefined {
		if (qualified === "xmlns" || qualified.startsWith("xmlns:")) return undefined

		const colon = qualified.indexOf(":")

		if (colon < 0) return { name: qualified, relationship: false }

		const prefix = qualified.slice(0, colon)
		const local = qualified.slice(colon + 1)

		if (prefix === "xml") return { name: qualified, relationship: false }

		const uri = reader.namespaces.uri(node, prefix)

		if (uri === undefined) return undefined

		return { name: `${this.prefix(uri)}:${local}`, relationship: drawingGroupOf(uri) === D.R }
	}

	// The document: every written part under one root declaring the prefixes used.
	finish(): string {
		const declarations: string[] = []

		for (const [uri, prefix] of this.prefixes) declarations.push(` xmlns:${prefix}="${escapeAttribute(uri)}"`)

		return `<p:scratch${declarations.join("")}>${this.parts.join("")}</p:scratch>`
	}
}

// Model values written as DrawingML (§20.1). Numbers are written as the model holds them (EMU, 1/100,000,
// 60,000ths of a degree), rounded to integers where the schema wants them.

function int(value: number): string {
	return String(Number.isFinite(value) ? Math.round(value) : 0)
}

function attribute(name: string, value: string | number | boolean | undefined): string {
	if (value === undefined) return ""

	const text = typeof value === "boolean" ? (value ? "1" : "0") : typeof value === "number" ? int(value) : value

	return ` ${name}="${escapeAttribute(text)}"`
}

const MOD_NAME = /^[A-Za-z]{1,16}$/

export function colorXml(color: ColorModel): string {
	let mods = ""

	for (const mod of color.mods ?? []) {
		if (MOD_NAME.test(mod.name)) mods += `<a:${mod.name}${attribute("val", mod.value)}/>`
	}

	switch (color.kind) {
		case "srgb":
			return `<a:srgbClr${attribute("val", color.rgb)}>${mods}</a:srgbClr>`
		case "scheme":
			return `<a:schemeClr${attribute("val", color.slot)}>${mods}</a:schemeClr>`
		case "preset":
			return `<a:prstClr${attribute("val", color.name)}>${mods}</a:prstClr>`
		case "system":
			return `<a:sysClr${attribute("val", color.name)}${attribute("lastClr", color.lastColor)}>${mods}</a:sysClr>`
	}
}

function edges(name: string, value: EdgeFractions | undefined): string {
	if (value === undefined) return ""

	return `<a:${name}${attribute("l", value.l)}${attribute("t", value.t)}${attribute("r", value.r)}${attribute("b", value.b)}/>`
}

// a:blip's adjustment children (in CT_Blip's order: alphaModFix, biLevel, duotone, grayscl, lum).
export function adjustXml(adjust: PictureAdjust): string {
	let out = ""

	// alpha: transparency, 0 (opaque) to 100,000.
	if (adjust.alpha !== undefined) out += `<a:alphaModFix${attribute("amt", 100_000 - Math.max(0, Math.min(100_000, adjust.alpha)))}/>`
	if (adjust.biLevel !== undefined) out += `<a:biLevel${attribute("thresh", Math.max(0, adjust.biLevel))}/>`
	if (adjust.duotone !== undefined) out += `<a:duotone>${colorXml(adjust.duotone[0])}${colorXml(adjust.duotone[1])}</a:duotone>`
	if (adjust.grayscale === true) out += "<a:grayscl/>"
	if ((adjust.brightness ?? 0) !== 0 || (adjust.contrast ?? 0) !== 0)
		out += `<a:lum${attribute("bright", adjust.brightness)}${attribute("contrast", adjust.contrast)}/>`

	return out
}

// A fill; a picture fill names its image through `image` (a scratch id), its adjustments (an edit's typed fill)
// drawn as the blip's.
export function fillXml(fill: FillProps | "none", image: (fill: Extract<FillProps, { kind: "picture" }>) => string | undefined): string {
	if (fill === "none") return "<a:noFill/>"

	switch (fill.kind) {
		case "solid":
			return `<a:solidFill>${colorXml(fill.color)}</a:solidFill>`
		case "gradient": {
			const stops = fill.stops.map(stop => `<a:gs${attribute("pos", stop.pos)}>${colorXml(stop.color)}</a:gs>`).join("")
			const shade =
				fill.path !== undefined
					? `<a:path${attribute("path", fill.path.shape)}>${edges("fillToRect", fill.path.fillTo)}</a:path>`
					: fill.linear !== undefined
						? `<a:lin${attribute("ang", fill.linear.angle)}${attribute("scaled", fill.linear.scaled)}/>`
						: ""

			return `<a:gradFill${attribute("rotWithShape", fill.rotWithShape)}><a:gsLst>${stops}</a:gsLst>${shade}</a:gradFill>`
		}
		case "pattern":
			return `<a:pattFill${attribute("prst", fill.preset)}><a:fgClr>${colorXml(fill.fg)}</a:fgClr><a:bgClr>${colorXml(fill.bg)}</a:bgClr></a:pattFill>`
		case "picture": {
			const id = image(fill)
			const adjust = "adjust" in fill ? adjustXml(fill.adjust as PictureAdjust) : ""
			const blip = `<a:blip${id === undefined ? "" : attribute("r:embed", id)}${adjust === "" ? "/>" : `>${adjust}</a:blip>`}`
			const placement =
				fill.tile !== undefined
					? `<a:tile${attribute("tx", fill.tile.tx)}${attribute("ty", fill.tile.ty)}${attribute("sx", fill.tile.sx)}${attribute("sy", fill.tile.sy)}${attribute("flip", fill.tile.flip)}${attribute("algn", fill.tile.algn)}/>`
					: `<a:stretch>${edges("fillRect", fill.stretch) || "<a:fillRect/>"}</a:stretch>`

			return `<a:blipFill>${blip}${edges("srcRect", fill.crop)}${placement}</a:blipFill>`
		}
		case "group":
			return "<a:grpFill/>"
	}
}

function lineEnd(name: string, end: LineEnd | undefined): string {
	return end === undefined ? "" : `<a:${name}${attribute("type", end.type)}${attribute("w", end.w)}${attribute("len", end.len)}/>`
}

export function lineXml(line: LineProps | "none", image: Parameters<typeof fillXml>[1]): string {
	if (line === "none") return "<a:ln><a:noFill/></a:ln>"

	let dash = ""

	if (line.custDash !== undefined) {
		for (let k = 0; k + 1 < line.custDash.length; k += 2)
			dash += `<a:ds${attribute("d", line.custDash[k] ?? 0)}${attribute("sp", line.custDash[k + 1] ?? 0)}/>`
		dash = `<a:custDash>${dash}</a:custDash>`
	} else if (line.dash !== undefined) {
		dash = `<a:prstDash${attribute("val", line.dash)}/>`
	}

	const join = line.join === undefined ? "" : line.join === "miter" ? "<a:miter/>" : `<a:${line.join}/>`
	const fill = line.fill === undefined ? "" : fillXml(line.fill, image)

	return `<a:ln${attribute("w", line.w)}${attribute("cap", line.cap)}${attribute("cmpd", line.compound)}${attribute("algn", line.align)}>${fill}${dash}${join}${lineEnd("headEnd", line.head)}${lineEnd("tailEnd", line.tail)}</a:ln>`
}

function effectXml(effect: Effect): string {
	switch (effect.kind) {
		case "outerShdw":
		case "innerShdw":
			return `<a:${effect.kind}${attribute("blurRad", effect.blurRad)}${attribute("dist", effect.dist)}${attribute("dir", effect.dir)}${attribute("sx", effect.sx)}${attribute("sy", effect.sy)}${attribute("algn", effect.algn)}${attribute("rotWithShape", effect.rotWithShape)}>${colorXml(effect.color)}</a:${effect.kind}>`
		case "prstShdw":
			return `<a:prstShdw${attribute("prst", effect.preset)}${attribute("dist", effect.dist)}${attribute("dir", effect.dir)}>${colorXml(effect.color)}</a:prstShdw>`
		case "glow":
			return `<a:glow${attribute("rad", effect.rad)}>${colorXml(effect.color)}</a:glow>`
		case "softEdge":
			return `<a:softEdge${attribute("rad", effect.rad)}/>`
		case "blur":
			return `<a:blur${attribute("rad", effect.rad)}${attribute("grow", effect.grow)}/>`
		case "reflection":
			return `<a:reflection${attribute("blurRad", effect.blurRad)}${attribute("stA", effect.stA)}${attribute("endA", effect.endA)}${attribute("endPos", effect.endPos)}${attribute("dist", effect.dist)}${attribute("dir", effect.dir)}${attribute("sy", effect.sy)}/>`
	}
}

export function effectsXml(effects: EffectList): string {
	return `<a:effectLst>${effects.effects.map(effectXml).join("")}</a:effectLst>`
}

function point(coords: Float64Array, at: number): string {
	return `<a:pt${attribute("x", coords[at] ?? 0)}${attribute("y", coords[at + 1] ?? 0)}/>`
}

export function geometryXml(geometry: Geometry): string {
	const guides = geometry.guides.map(guide => `<a:gd${attribute("name", guide.name)}${attribute("fmla", guide.formula)}/>`).join("")

	if (geometry.kind === "preset") return `<a:prstGeom${attribute("prst", geometry.preset)}><a:avLst>${guides}</a:avLst></a:prstGeom>`

	const paths = geometry.paths
		.map(path => {
			let commands = ""
			let at = 0

			for (const command of path.commands) {
				switch (command) {
					case PATH_MOVE:
						commands += `<a:moveTo>${point(path.coords, at)}</a:moveTo>`
						at += 2
						break
					case PATH_LINE:
						commands += `<a:lnTo>${point(path.coords, at)}</a:lnTo>`
						at += 2
						break
					case PATH_CUBIC:
						commands += `<a:cubicBezTo>${point(path.coords, at)}${point(path.coords, at + 2)}${point(path.coords, at + 4)}</a:cubicBezTo>`
						at += 6
						break
					case PATH_QUAD:
						commands += `<a:quadBezTo>${point(path.coords, at)}${point(path.coords, at + 2)}</a:quadBezTo>`
						at += 4
						break
					case PATH_ARC:
						commands += `<a:arcTo${attribute("wR", path.coords[at] ?? 0)}${attribute("hR", path.coords[at + 1] ?? 0)}${attribute("stAng", path.coords[at + 2] ?? 0)}${attribute("swAng", path.coords[at + 3] ?? 0)}/>`
						at += 4
						break
					case PATH_CLOSE:
						commands += "<a:close/>"
						break
					default:
						break
				}
			}

			return `<a:path${attribute("w", path.w)}${attribute("h", path.h)}${attribute("fill", path.fill)}${attribute("stroke", path.stroke)}${attribute("extrusionOk", path.extrusionOk)}>${commands}</a:path>`
		})
		.join("")
	const rect =
		geometry.textRect === undefined
			? ""
			: `<a:rect${attribute("l", geometry.textRect.l)}${attribute("t", geometry.textRect.t)}${attribute("r", geometry.textRect.r)}${attribute("b", geometry.textRect.b)}/>`

	return `<a:custGeom><a:avLst/><a:gdLst>${guides}</a:gdLst>${rect}<a:pathLst>${paths}</a:pathLst></a:custGeom>`
}

const EMU_PER_PX = 9525

// Resolved body properties as a:bodyPr (px insets back to EMU).
export function bodyPrXml(body: TextBodyProps): string {
	const autofit =
		body.autofit === "shape"
			? "<a:spAutoFit/>"
			: body.autofit === "normal"
				? `<a:normAutofit${attribute("fontScale", body.fontScale * 100000)}${attribute("lnSpcReduction", body.lineSpacingReduction * 100000)}/>`
				: "<a:noAutofit/>"

	return (
		`<a:bodyPr${attribute("lIns", body.insets.left * EMU_PER_PX)}${attribute("tIns", body.insets.top * EMU_PER_PX)}` +
		`${attribute("rIns", body.insets.right * EMU_PER_PX)}${attribute("bIns", body.insets.bottom * EMU_PER_PX)}` +
		`${attribute("anchor", body.anchor)}${attribute("anchorCtr", body.anchorCenter)}${attribute("vert", body.vertical)}` +
		`${attribute("wrap", body.wrap ? "square" : "none")}${attribute("rot", body.rotation * 60000)}${attribute("upright", body.upright)}` +
		`${attribute("numCol", body.columns)}${attribute("spcCol", body.columnSpacing * EMU_PER_PX)}>${autofit}</a:bodyPr>`
	)
}
