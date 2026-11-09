import { EMU_PER_PX, type TextBodyProps, type TextUnderline } from "../../drawingml/index"
import type { Relationships } from "../../opc/index"
import type { DeckTally } from "../../presentation/budget"
import type {
	Action,
	Bullet,
	ColorMod,
	ColorModel,
	Effect,
	EffectList,
	FillProps,
	FontRef,
	LineEnd,
	LineProps,
	ListStyle,
	Paragraph,
	ParaProps,
	Run,
	RunProps,
	SchemeSlot,
	SourceRef,
	Spacing,
	TableCell,
	TableCellProps,
	TableModel,
	TableRow,
	TextBody,
	Xfrm
} from "../../presentation/model"
import { tooLarge } from "../../presentation/refusal"
import { G, type PartReader } from "./xml"

// DrawingML (ECMA-376 Part 1 §20.1, §21.1) into the presentation model's own types: colours stay theme-relative,
// fills and lines as written, text bodies as paragraphs and runs with only the properties the source wrote (the
// inheritance chain fills the rest). Shape geometry, fills and effects of shapes stay in the source (the renderer
// reads them there); what is read here is what inheritance, text layout, backgrounds and tables need.

export interface ReadContext {
	readonly reader: PartReader
	readonly part: string
	readonly epoch: number
	readonly relationships: Relationships
	readonly tally: DeckTally
	// A hyperlink element (a:hlinkClick / a:hlinkHover) classified.
	action(node: number): Action | undefined
}

export function sourceRef(context: ReadContext, node: number): SourceRef {
	return { format: "pptx", part: context.part, node, epoch: context.epoch }
}

// The internal part a relationship id names ("/ppt/media/image1.png"), or undefined.
export function relPart(context: ReadContext, id: string | undefined): string | undefined {
	if (id === undefined) return undefined

	const relationship = context.relationships.byId(id)

	return relationship === undefined || relationship.external || relationship.partName === undefined
		? undefined
		: `/${relationship.partName}`
}

const SCHEME_SLOTS: ReadonlySet<string> = new Set([
	"dk1",
	"lt1",
	"dk2",
	"lt2",
	"accent1",
	"accent2",
	"accent3",
	"accent4",
	"accent5",
	"accent6",
	"hlink",
	"folHlink",
	"bg1",
	"tx1",
	"bg2",
	"tx2",
	"phClr"
])

const COLOR_LOCALS: ReadonlySet<string> = new Set(["srgbClr", "schemeClr", "prstClr", "sysClr", "scrgbClr", "hslClr"])

function modsOf(r: PartReader, node: number): ColorMod[] | undefined {
	let out: ColorMod[] | undefined

	for (let child = r.first(node); child >= 0; child = r.next(child)) {
		if (r.group(child) !== G.A) continue

		const name = r.local(child)
		const raw = r.attr(child, "val")
		let value: number | undefined

		if (raw !== undefined) {
			const trimmed = raw.trim()
			const number = Number.parseFloat(trimmed)

			// Strict writes "50%"; hue values are angles either way.
			value = Number.isFinite(number) ? (trimmed.endsWith("%") ? Math.round(number * 1000) : number) : undefined
		}

		;(out ??= []).push(value === undefined ? { name } : { name, value })
	}

	return out
}

function hex2(value: number): string {
	return Math.round(Math.min(1, Math.max(0, value)) * 255)
		.toString(16)
		.padStart(2, "0")
}

function fromLinear(channel: number): number {
	return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
}

function hslHex(h: number, s: number, l: number): string {
	const k = (n: number): number => (n + h / 30) % 12
	const a = s * Math.min(l, 1 - l)
	const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))

	return (hex2(f(0)) + hex2(f(8)) + hex2(f(4))).toUpperCase()
}

// One colour choice element (§20.1.2.3): scRGB and HSL become sRGB, the transforms are kept in order.
export function readColor(r: PartReader, node: number): ColorModel | undefined {
	if (r.group(node) !== G.A) return undefined

	const mods = modsOf(r, node)
	const withMods = (value: ColorModel): ColorModel => (mods === undefined ? value : { ...value, mods })

	switch (r.local(node)) {
		case "srgbClr": {
			const value = r.attr(node, "val")

			return value !== undefined && /^[0-9A-Fa-f]{6}$/u.test(value) ? withMods({ kind: "srgb", rgb: value.toUpperCase() }) : undefined
		}
		case "schemeClr": {
			const value = r.attr(node, "val") ?? ""

			return SCHEME_SLOTS.has(value) ? withMods({ kind: "scheme", slot: value as SchemeSlot }) : undefined
		}
		case "prstClr":
			return withMods({ kind: "preset", name: r.attr(node, "val") ?? "" })
		case "sysClr": {
			const last = r.attr(node, "lastClr")

			return withMods({ kind: "system", name: r.attr(node, "val") ?? "", ...(last === undefined ? {} : { lastColor: last }) })
		}
		case "scrgbClr": {
			const channel = (name: string): number => fromLinear((r.percent(node, name) ?? 0) / 100000)

			return withMods({ kind: "srgb", rgb: (hex2(channel("r")) + hex2(channel("g")) + hex2(channel("b"))).toUpperCase() })
		}
		case "hslClr":
			return withMods({
				kind: "srgb",
				rgb: hslHex(
					((((r.number(node, "hue") ?? 0) / 60000) % 360) + 360) % 360,
					(r.percent(node, "sat") ?? 0) / 100000,
					(r.percent(node, "lum") ?? 0) / 100000
				)
			})
		default:
			return undefined
	}
}

// The colour inside a container (a:solidFill, a:fgClr, a:buClr…).
export function colorIn(r: PartReader, container: number): ColorModel | undefined {
	for (let child = r.first(container); child >= 0; child = r.next(child)) {
		if (r.group(child) === G.A && COLOR_LOCALS.has(r.local(child))) return readColor(r, child)
	}

	return undefined
}

function edges(r: PartReader, node: number): { l: number; t: number; r: number; b: number } | undefined {
	if (node < 0) return undefined

	return { l: r.percent(node, "l") ?? 0, t: r.percent(node, "t") ?? 0, r: r.percent(node, "r") ?? 0, b: r.percent(node, "b") ?? 0 }
}

const FILL_LOCALS: ReadonlySet<string> = new Set(["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"])

// The fill element among a container's children (spPr, rPr, tcPr, bgPr, a:uFill…), or -1.
export function fillChild(r: PartReader, container: number): number {
	for (let child = r.first(container); child >= 0; child = r.next(child)) {
		if (r.group(child) === G.A && FILL_LOCALS.has(r.local(child))) return child
	}

	return -1
}

// A fill element as written (§20.1.8). `pictures` resolves a:blip r:embed.
export function readFill(context: ReadContext, node: number): FillProps | "none" | undefined {
	const r = context.reader

	switch (node < 0 ? "" : r.local(node)) {
		case "noFill":
			return "none"
		case "solidFill": {
			const color = colorIn(r, node)

			return color === undefined ? undefined : { kind: "solid", color }
		}
		case "gradFill": {
			const stops: { pos: number; color: ColorModel }[] = []

			for (const gs of r.children(r.child(node, G.A, "gsLst"), G.A, "gs")) {
				const color = colorIn(r, gs)

				if (color !== undefined) stops.push({ pos: r.percent(gs, "pos") ?? 0, color })
			}

			const lin = r.child(node, G.A, "lin")
			const path = r.child(node, G.A, "path")
			const rot = r.bool(node, "rotWithShape")
			const shape = r.attr(path, "path")

			return {
				kind: "gradient",
				stops,
				...(lin < 0 ? {} : { linear: { angle: r.int(lin, "ang") ?? 0, scaled: r.bool(lin, "scaled") ?? false } }),
				...(path < 0
					? {}
					: {
							path: {
								shape: shape === "rect" || shape === "shape" ? shape : "circle",
								fillTo: edges(r, r.child(path, G.A, "fillToRect")) ?? { l: 0, t: 0, r: 0, b: 0 }
							}
						}),
				...(rot === undefined ? {} : { rotWithShape: rot })
			}
		}
		case "pattFill": {
			const fg = colorIn(r, r.child(node, G.A, "fgClr")) ?? { kind: "srgb", rgb: "000000" }
			const bg = colorIn(r, r.child(node, G.A, "bgClr")) ?? { kind: "srgb", rgb: "FFFFFF" }

			return { kind: "pattern", preset: r.attr(node, "prst") ?? "pct5", fg, bg }
		}
		case "blipFill":
			return readBlipFill(context, node)
		case "grpFill":
			return { kind: "group" }
		default:
			return undefined
	}
}

const SVG_BLIP_EXT = "{96DAC541-7B7A-43D3-8B79-37D633B846F1}"

function svgBlip(r: ReadContext["reader"], blip: number): number {
	for (const ext of r.children(r.child(blip, G.A, "extLst"), G.A, "ext"))
		if (r.attr(ext, "uri") === SVG_BLIP_EXT) return r.child(ext, G.Asvg, "svgBlip")

	return -1
}

export function readBlipFill(context: ReadContext, node: number): FillProps {
	const r = context.reader
	const blip = r.child(node, G.A, "blip")
	// An SVG-only picture (a:blip without r:embed, its image in the a:extLst's asvg:svgBlip) names that image.
	const part = relPart(context, r.rel(blip, "embed")) ?? relPart(context, r.rel(svgBlip(r, blip), "embed"))
	const crop = edges(r, r.child(node, G.A, "srcRect"))
	const stretch = r.child(node, G.A, "stretch")
	const tile = r.child(node, G.A, "tile")
	const flip = r.attr(tile, "flip")

	return {
		kind: "picture",
		...(part === undefined ? {} : { part }),
		...(crop === undefined ? {} : { crop }),
		...(stretch < 0 ? {} : { stretch: edges(r, r.child(stretch, G.A, "fillRect")) ?? { l: 0, t: 0, r: 0, b: 0 } }),
		...(tile < 0
			? {}
			: {
					tile: {
						tx: r.emu(tile, "tx") ?? 0,
						ty: r.emu(tile, "ty") ?? 0,
						sx: r.percent(tile, "sx") ?? 100000,
						sy: r.percent(tile, "sy") ?? 100000,
						flip: flip === "x" || flip === "y" || flip === "xy" ? flip : "none",
						algn: r.attr(tile, "algn") ?? "tl"
					}
				})
	}
}

export function fillOf(context: ReadContext, container: number): FillProps | "none" | undefined {
	return readFill(context, fillChild(context.reader, container))
}

const LINE_ENDS: ReadonlySet<string> = new Set(["none", "triangle", "stealth", "diamond", "oval", "arrow"])
const SIZES: ReadonlySet<string> = new Set(["sm", "med", "lg"])

function lineEnd(r: PartReader, node: number): LineEnd | undefined {
	if (node < 0) return undefined

	const type = r.attr(node, "type") ?? "none"
	const w = r.attr(node, "w") ?? "med"
	const len = r.attr(node, "len") ?? "med"

	return {
		type: (LINE_ENDS.has(type) ? type : "none") as LineEnd["type"],
		w: (SIZES.has(w) ? w : "med") as LineEnd["w"],
		len: (SIZES.has(len) ? len : "med") as LineEnd["len"]
	}
}

// a:ln (CT_LineProperties, §20.1.2.2.24) as written.
export function readLine(context: ReadContext, node: number): LineProps {
	const r = context.reader
	const fill = fillOf(context, node)
	const cap = r.attr(node, "cap")
	const compound = r.attr(node, "cmpd")
	const align = r.attr(node, "algn")
	const join =
		r.child(node, G.A, "round") >= 0
			? "round"
			: r.child(node, G.A, "bevel") >= 0
				? "bevel"
				: r.child(node, G.A, "miter") >= 0
					? "miter"
					: undefined
	const custDash = r.child(node, G.A, "custDash")
	let dashes: Float64Array | undefined

	if (custDash >= 0) {
		const ds = r.children(custDash, G.A, "ds")

		dashes = new Float64Array(ds.length * 2)
		ds.forEach((d, index) => {
			dashes?.set([r.percent(d, "d") ?? 0, r.percent(d, "sp") ?? 0], index * 2)
		})
	}

	const w = r.emu(node, "w")
	const head = lineEnd(r, r.child(node, G.A, "headEnd"))
	const tail = lineEnd(r, r.child(node, G.A, "tailEnd"))
	const dash = r.attr(r.child(node, G.A, "prstDash"), "val")

	return {
		...(w === undefined ? {} : { w }),
		...(fill === undefined ? {} : { fill }),
		...(dash === undefined ? {} : { dash }),
		...(dashes === undefined ? {} : { custDash: dashes }),
		...(cap === "rnd" || cap === "sq" || cap === "flat" ? { cap } : {}),
		...(join === undefined ? {} : { join }),
		...(compound === "sng" || compound === "dbl" || compound === "thickThin" || compound === "thinThick" || compound === "tri"
			? { compound }
			: {}),
		...(align === "ctr" || align === "in" ? { align } : {}),
		...(head === undefined ? {} : { head }),
		...(tail === undefined ? {} : { tail })
	}
}

const BLACK: ColorModel = { kind: "srgb", rgb: "000000" }

// a:effectLst (§20.1.8.26) with the effects the model names; anything else stays in the source (`src`).
export function readEffects(context: ReadContext, node: number): EffectList {
	const r = context.reader
	const effects: Effect[] = []
	// CT_EffectList holds each kind at most once: the first is read, repeats stay in the source only.
	const seen = new Set<string>()

	for (let child = r.first(node); child >= 0; child = r.next(child)) {
		if (r.group(child) !== G.A || seen.has(r.local(child))) continue

		seen.add(r.local(child))

		const color = colorIn(r, child) ?? BLACK

		switch (r.local(child)) {
			case "outerShdw":
			case "innerShdw": {
				const sx = r.percent(child, "sx")
				const sy = r.percent(child, "sy")
				const algn = r.attr(child, "algn")
				const rot = r.bool(child, "rotWithShape")

				effects.push({
					kind: r.local(child) as "outerShdw" | "innerShdw",
					color,
					blurRad: r.emu(child, "blurRad") ?? 0,
					dist: r.emu(child, "dist") ?? 0,
					dir: r.int(child, "dir") ?? 0,
					...(sx === undefined ? {} : { sx }),
					...(sy === undefined ? {} : { sy }),
					...(algn === undefined ? {} : { algn }),
					...(rot === undefined ? {} : { rotWithShape: rot })
				})

				break
			}
			case "prstShdw":
				effects.push({
					kind: "prstShdw",
					preset: r.attr(child, "prst") ?? "shdw1",
					color,
					dist: r.emu(child, "dist") ?? 0,
					dir: r.int(child, "dir") ?? 0
				})
				break
			case "glow":
				effects.push({ kind: "glow", color, rad: r.emu(child, "rad") ?? 0 })
				break
			case "softEdge":
				effects.push({ kind: "softEdge", rad: r.emu(child, "rad") ?? 0 })
				break
			case "blur":
				effects.push({ kind: "blur", rad: r.emu(child, "rad") ?? 0, grow: r.bool(child, "grow") ?? true })
				break
			case "reflection": {
				const sy = r.percent(child, "sy")

				effects.push({
					kind: "reflection",
					blurRad: r.emu(child, "blurRad") ?? 0,
					stA: r.percent(child, "stA") ?? 100000,
					endA: r.percent(child, "endA") ?? 0,
					endPos: r.percent(child, "endPos") ?? 100000,
					dist: r.emu(child, "dist") ?? 0,
					dir: r.int(child, "dir") ?? 0,
					...(sy === undefined ? {} : { sy })
				})

				break
			}
		}
	}

	return { effects, src: sourceRef(context, node) }
}

// a:xfrm or p:xfrm (§20.1.7.6): EMU, rotation in 60,000ths of a degree.
export function readXfrm(r: PartReader, node: number): Xfrm | undefined {
	if (node < 0) return undefined

	const off = r.child(node, G.A, "off")
	const ext = r.child(node, G.A, "ext")
	const chOff = r.child(node, G.A, "chOff")
	const chExt = r.child(node, G.A, "chExt")

	// An xfrm without off or ext places nothing: the shape inherits as if it had none (PowerPoint reads it so).
	if (off < 0 || ext < 0) return undefined

	return {
		x: r.emu(off, "x") ?? 0,
		y: r.emu(off, "y") ?? 0,
		cx: Math.max(0, r.emu(ext, "cx") ?? 0),
		cy: Math.max(0, r.emu(ext, "cy") ?? 0),
		rot: r.int(node, "rot") ?? 0,
		flipH: r.bool(node, "flipH") ?? false,
		flipV: r.bool(node, "flipV") ?? false,
		...(chOff < 0 ? {} : { chX: r.emu(chOff, "x") ?? 0, chY: r.emu(chOff, "y") ?? 0 }),
		...(chExt < 0 ? {} : { chCx: r.emu(chExt, "cx") ?? 0, chCy: r.emu(chExt, "cy") ?? 0 })
	}
}

const ANCHORS: ReadonlySet<string> = new Set(["t", "ctr", "b", "just", "dist"])
const VERTICALS: ReadonlySet<string> = new Set(["horz", "vert", "vert270", "wordArtVert", "eaVert", "mongolianVert", "wordArtVertRtl"])

// a:bodyPr (§21.1.2.1.1) with only the attributes written: inheritance resolves bodyPr attribute by attribute.
// Insets are one object in TextBodyProps: a side the source did not write is NaN (inherit), resolved by inherit.ts.
export function readBodyPr(r: PartReader, node: number): Partial<TextBodyProps> {
	if (node < 0) return {}

	const out: { -readonly [K in keyof TextBodyProps]?: TextBodyProps[K] } = {}
	const inset = (name: string): number => {
		const value = r.emu(node, name)

		return value === undefined ? Number.NaN : value / EMU_PER_PX
	}
	const insets = { left: inset("lIns"), top: inset("tIns"), right: inset("rIns"), bottom: inset("bIns") }

	if (!(Number.isNaN(insets.left) && Number.isNaN(insets.top) && Number.isNaN(insets.right) && Number.isNaN(insets.bottom))) {
		out.insets = insets
	}

	const anchor = r.attr(node, "anchor")
	const vertical = r.attr(node, "vert")
	const anchorCenter = r.bool(node, "anchorCtr")
	const wrap = r.attr(node, "wrap")
	const rotation = r.int(node, "rot")
	const upright = r.bool(node, "upright")
	const columns = r.int(node, "numCol")
	const spacing = r.emu(node, "spcCol")

	if (anchor !== undefined && ANCHORS.has(anchor)) out.anchor = anchor as TextBodyProps["anchor"]
	if (vertical !== undefined && VERTICALS.has(vertical)) out.vertical = vertical as TextBodyProps["vertical"]
	if (anchorCenter !== undefined) out.anchorCenter = anchorCenter
	if (wrap !== undefined) out.wrap = wrap !== "none"
	if (rotation !== undefined) out.rotation = rotation / 60000
	if (upright !== undefined) out.upright = upright
	if (columns !== undefined) out.columns = Math.max(1, Math.min(16, columns))
	if (spacing !== undefined) out.columnSpacing = spacing / EMU_PER_PX

	const normal = r.child(node, G.A, "normAutofit")

	if (r.child(node, G.A, "spAutoFit") >= 0) {
		out.autofit = "shape"
	} else if (normal >= 0) {
		out.autofit = "normal"
		out.fontScale = (r.percent(normal, "fontScale") ?? 100000) / 100000
		out.lineSpacingReduction = (r.percent(normal, "lnSpcReduction") ?? 0) / 100000
	} else if (r.child(node, G.A, "noAutofit") >= 0) {
		out.autofit = "none"
	}

	return out
}

function fontRef(r: PartReader, node: number): FontRef | undefined {
	if (node < 0) return undefined

	const panose = r.attr(node, "panose")
	const pitchFamily = r.int(node, "pitchFamily")
	const charset = r.int(node, "charset")

	return {
		typeface: r.attr(node, "typeface") ?? "",
		...(panose === undefined ? {} : { panose }),
		...(pitchFamily === undefined ? {} : { pitchFamily }),
		...(charset === undefined ? {} : { charset })
	}
}

const UNDERLINE_VALUES: ReadonlySet<string> = new Set([
	"none",
	"words",
	"sng",
	"dbl",
	"heavy",
	"dotted",
	"dottedHeavy",
	"dash",
	"dashHeavy",
	"dashLong",
	"dashLongHeavy",
	"dotDash",
	"dotDashHeavy",
	"dotDotDash",
	"dotDotDashHeavy",
	"wavy",
	"wavyHeavy",
	"wavyDbl"
])

// a:rPr, a:defRPr, a:endParaRPr (CT_TextCharacterProperties, §21.1.2.3.2) as written.
export function readRunProps(context: ReadContext, node: number): RunProps {
	if (node < 0) return {}

	const r = context.reader
	const out: { -readonly [K in keyof RunProps]?: RunProps[K] } = {}
	const sz = r.int(node, "sz")
	const b = r.bool(node, "b")
	const i = r.bool(node, "i")
	const u = r.attr(node, "u")
	const strike = r.attr(node, "strike")
	const baseline = r.percent(node, "baseline")
	const cap = r.attr(node, "cap")
	const spc = r.int(node, "spc")
	const kern = r.int(node, "kern")
	const lang = r.attr(node, "lang")
	const altLang = r.attr(node, "altLang")
	const noProof = r.bool(node, "noProof")

	if (sz !== undefined && sz >= 100 && sz <= 400000) out.sz = sz
	if (b !== undefined) out.b = b
	if (i !== undefined) out.i = i
	if (u !== undefined && UNDERLINE_VALUES.has(u)) out.u = u as TextUnderline
	if (strike === "noStrike" || strike === "sngStrike" || strike === "dblStrike") out.strike = strike
	if (baseline !== undefined) out.baseline = baseline
	if (cap === "none" || cap === "small" || cap === "all") out.cap = cap
	if (spc !== undefined) out.spc = spc
	if (kern !== undefined) out.kern = kern
	if (lang !== undefined) out.lang = lang
	if (altLang !== undefined) out.altLang = altLang
	if (noProof !== undefined) out.noProof = noProof

	for (let child = r.first(node); child >= 0; child = r.next(child)) {
		if (r.group(child) !== G.A) continue

		switch (r.local(child)) {
			case "ln":
				out.ln = readLine(context, child)
				break
			case "noFill":
			case "solidFill":
			case "gradFill":
			case "blipFill":
			case "pattFill":
			case "grpFill": {
				const fill = readFill(context, child)

				if (fill !== undefined) out.fill = fill

				break
			}
			case "effectLst":
				out.effects = readEffects(context, child)
				break
			case "highlight": {
				const color = colorIn(r, child)

				if (color !== undefined) out.highlight = color

				break
			}
			case "uLnTx":
				out.uLn = "text"
				break
			case "uLn":
				out.uLn = readLine(context, child)
				break
			case "uFillTx":
				out.uFill = "text"
				break
			case "uFill": {
				const fill = fillOf(context, child)

				if (fill !== undefined && fill !== "none") out.uFill = fill

				break
			}
			case "latin":
			case "ea":
			case "cs":
			case "sym": {
				const font = fontRef(r, child)

				if (font !== undefined) out[r.local(child) as "latin" | "ea" | "cs" | "sym"] = font

				break
			}
			case "hlinkClick": {
				const action = runAction(context, child)

				if (action !== undefined) out.hlinkClick = action

				break
			}
			case "hlinkMouseOver": {
				const action = runAction(context, child)

				if (action !== undefined) out.hlinkMouseOver = action

				break
			}
		}
	}

	return out
}

// A run's a:hlinkClick / a:hlinkMouseOver with its colour extension: ahyp:hlinkClr val="tx" (PowerPoint 2019+, a
// recoloured hyperlink) draws in the run's own colour. Found by its namespace, under any a:ext uri; the element stays
// in the source, which a save keeps.
function runAction(context: ReadContext, node: number): Action | undefined {
	const action = context.action(node)

	if (action === undefined) return undefined

	const r = context.reader

	for (const ext of r.children(r.child(node, G.A, "extLst"), G.A, "ext")) {
		const color = r.child(ext, G.Ahyp, "hlinkClr")

		if (color >= 0) return r.attr(color, "val") === "tx" ? { ...action, color: "tx" } : action
	}

	return action
}

function spacing(r: PartReader, node: number): Spacing | undefined {
	if (node < 0) return undefined

	const pct = r.child(node, G.A, "spcPct")

	if (pct >= 0) {
		const value = r.percent(pct, "val")

		return value === undefined ? undefined : { pct: value }
	}

	const pts = r.int(r.child(node, G.A, "spcPts"), "val")

	return pts === undefined ? undefined : { pts }
}

const ALIGNS: ReadonlySet<string> = new Set(["l", "ctr", "r", "just", "dist", "justLow", "thaiDist"])
const FONT_ALIGNS: ReadonlySet<string> = new Set(["auto", "t", "ctr", "base", "b"])
const TAB_ALIGNS: ReadonlySet<string> = new Set(["l", "ctr", "r", "dec"])

// a:pPr and the a:lvlNpPr of a list style (CT_TextParagraphProperties, §21.1.2.2.7) as written.
export function readParaProps(context: ReadContext, node: number): ParaProps {
	if (node < 0) return {}

	const r = context.reader
	const out: { -readonly [K in keyof ParaProps]?: ParaProps[K] } = {}
	const lvl = r.int(node, "lvl")
	const algn = r.attr(node, "algn")
	const fontAlgn = r.attr(node, "fontAlgn")

	if (lvl !== undefined) out.lvl = Math.max(0, Math.min(8, lvl))
	if (algn !== undefined && ALIGNS.has(algn)) out.algn = algn as NonNullable<ParaProps["algn"]>
	if (fontAlgn !== undefined && FONT_ALIGNS.has(fontAlgn)) out.fontAlgn = fontAlgn as NonNullable<ParaProps["fontAlgn"]>

	for (const name of ["marL", "marR", "indent", "defTabSz"] as const) {
		const value = r.emu(node, name)

		if (value !== undefined) out[name] = value
	}

	for (const name of ["rtl", "eaLnBrk", "latinLnBrk", "hangingPunct"] as const) {
		const value = r.bool(node, name)

		if (value !== undefined) out[name] = value
	}

	for (let child = r.first(node); child >= 0; child = r.next(child)) {
		if (r.group(child) !== G.A) continue

		switch (r.local(child)) {
			case "lnSpc":
			case "spcBef":
			case "spcAft": {
				const value = spacing(r, child)

				if (value !== undefined) out[r.local(child) as "lnSpc" | "spcBef" | "spcAft"] = value

				break
			}
			case "buClrTx":
				out.buClr = "text"
				break
			case "buClr": {
				const color = colorIn(r, child)

				if (color !== undefined) out.buClr = color

				break
			}
			case "buSzTx":
				out.buSz = "text"
				break
			case "buSzPct": {
				const value = r.percent(child, "val")

				if (value !== undefined) out.buSz = { pct: value }

				break
			}
			case "buSzPts": {
				const value = r.int(child, "val")

				if (value !== undefined) out.buSz = { pts: value }

				break
			}
			case "buFontTx":
				out.buFont = "text"
				break
			case "buFont": {
				const font = fontRef(r, child)

				if (font !== undefined) out.buFont = font

				break
			}
			case "buNone":
				out.bullet = { kind: "none" }
				break
			case "buAutoNum": {
				const startAt = r.int(child, "startAt")
				const bullet: Bullet = {
					kind: "autoNum",
					scheme: r.attr(child, "type") ?? "arabicPeriod",
					...(startAt === undefined ? {} : { startAt })
				}

				out.bullet = bullet

				break
			}
			case "buChar":
				out.bullet = { kind: "char", char: r.attr(child, "char") ?? "•" }
				break
			case "buBlip": {
				const part = relPart(context, r.rel(r.child(child, G.A, "blip"), "embed"))

				out.bullet = part === undefined ? { kind: "char", char: "•" } : { kind: "blip", part }

				break
			}
			case "tabLst": {
				const tabs: { pos: number; algn: "l" | "ctr" | "r" | "dec" }[] = []

				for (const tab of r.children(child, G.A, "tab")) {
					const tabAlign = r.attr(tab, "algn") ?? "l"

					tabs.push({ pos: r.emu(tab, "pos") ?? 0, algn: (TAB_ALIGNS.has(tabAlign) ? tabAlign : "l") as "l" })
				}

				out.tabs = tabs

				break
			}
			case "defRPr":
				out.defRPr = readRunProps(context, child)
				break
		}
	}

	return out
}

// a:lstStyle, p:titleStyle, p:defaultTextStyle… (CT_TextListStyle, §21.1.2.4.12).
export function readListStyle(context: ReadContext, node: number): ListStyle {
	const r = context.reader
	const levels: (ParaProps | undefined)[] = []
	let def: ParaProps | undefined

	for (let child = r.first(node); child >= 0; child = r.next(child)) {
		if (r.group(child) !== G.A) continue

		const local = r.local(child)

		if (local === "defPPr") {
			def = readParaProps(context, child)
		} else {
			const match = /^lvl([1-9])pPr$/u.exec(local)

			if (match !== null) levels[Number(match[1]) - 1] = readParaProps(context, child)
		}
	}

	return def === undefined ? { levels } : { def, levels }
}

function textOf(r: PartReader, run: number): string {
	return r.text(r.child(run, G.A, "t"))
}

// The text a mc:AlternateContent inside a paragraph shows (math with a picture Fallback): its Fallback runs'.
function alternateText(r: PartReader, node: number): string {
	const fallback = r.child(node, G.MC, "Fallback")
	let out = ""

	for (let child = r.first(fallback); child >= 0; child = r.next(child)) {
		if (r.is(child, G.A, "r")) out += textOf(r, child)
	}

	return out
}

// a:txBody / p:txBody (§21.1.2.1.1): paragraphs and runs as written.
export function readTextBody(context: ReadContext, node: number): TextBody {
	const r = context.reader
	const lstStyle = r.child(node, G.A, "lstStyle")
	const paragraphs: Paragraph[] = []
	let runs = 0
	const tally = context.tally

	for (const p of r.children(node, G.A, "p")) {
		const out: Run[] = []
		let endRPr: RunProps | undefined

		for (let child = r.first(p); child >= 0; child = r.next(child)) {
			const group = r.group(child)

			if (group === G.MC && r.local(child) === "AlternateContent") {
				out.push({ kind: "opaque", src: sourceRef(context, child), text: alternateText(r, child) })
				runs++
			} else if (group === G.A) {
				switch (r.local(child)) {
					case "r": {
						const text = textOf(r, child)

						tally.characters += text.length
						out.push({ kind: "r", text, rPr: readRunProps(context, r.child(child, G.A, "rPr")) })
						runs++

						break
					}
					case "br":
						out.push({ kind: "br", rPr: readRunProps(context, r.child(child, G.A, "rPr")) })
						runs++
						break
					case "fld": {
						const text = textOf(r, child)

						tally.characters += text.length
						out.push({
							kind: "fld",
							type: r.attr(child, "type") ?? "",
							id: r.attr(child, "id") ?? "",
							text,
							rPr: readRunProps(context, r.child(child, G.A, "rPr"))
						})
						runs++

						break
					}
					case "endParaRPr":
						endRPr = readRunProps(context, child)
						break
				}
			}

			if (runs > tally.budgets.runsPerBody) tooLarge("text runs in a body", tally.budgets.runsPerBody)
			// The part's runs so far: the bodies read before this one and this one's.
			if (tally.partRuns + runs > tally.budgets.runsPerSlide) tooLarge("text runs on a slide", tally.budgets.runsPerSlide)
		}

		if (tally.characters > tally.budgets.charactersPerDeck) tooLarge("characters in the deck", tally.budgets.charactersPerDeck)

		paragraphs.push({
			pPr: readParaProps(context, r.child(p, G.A, "pPr")),
			runs: out,
			...(endRPr === undefined ? {} : { endRPr }),
			src: sourceRef(context, p)
		})
	}

	tally.partRuns += runs

	return {
		bodyPr: readBodyPr(r, r.child(node, G.A, "bodyPr")),
		...(lstStyle < 0 ? {} : { lstStyle: readListStyle(context, lstStyle) }),
		paragraphs
	}
}

const CELL_BORDERS = [
	["lnL", "l"],
	["lnR", "r"],
	["lnT", "t"],
	["lnB", "b"],
	["lnTlToBr", "tl2br"],
	["lnBlToTr", "bl2tr"]
] as const

function cellProps(context: ReadContext, node: number): TableCellProps | undefined {
	if (node < 0) return undefined

	const r = context.reader
	const out: { -readonly [K in keyof TableCellProps]?: TableCellProps[K] } = {}
	const borders: { [side in "l" | "r" | "t" | "b" | "tl2br" | "bl2tr"]?: LineProps | "none" } = {}
	let anyBorder = false

	for (const name of ["marL", "marR", "marT", "marB"] as const) {
		const value = r.emu(node, name)

		if (value !== undefined) out[name] = value
	}

	const anchor = r.attr(node, "anchor")
	const vert = r.attr(node, "vert")

	if (anchor === "t" || anchor === "ctr" || anchor === "b") out.anchor = anchor
	if (vert !== undefined) out.vert = vert

	for (const [local, side] of CELL_BORDERS) {
		const ln = r.child(node, G.A, local)

		if (ln < 0) continue

		const line = readLine(context, ln)

		borders[side] = line.fill === "none" ? "none" : line
		anyBorder = true
	}

	if (anyBorder) out.borders = borders

	const fill = fillOf(context, node)

	if (fill !== undefined) out.fill = fill

	return out
}

// a:tbl (§21.1.3.13).
export function readTable(context: ReadContext, node: number): TableModel {
	const r = context.reader
	const budgets = context.tally.budgets
	const tblPr = r.child(node, G.A, "tblPr")
	const grid = r.children(r.child(node, G.A, "tblGrid"), G.A, "gridCol").map(col => Math.max(0, r.emu(col, "w") ?? 0))
	const rows: TableRow[] = []
	let cells = 0

	if (grid.length > budgets.gridColumns) tooLarge("table grid columns", budgets.gridColumns)

	for (const tr of r.children(node, G.A, "tr")) {
		const row: TableCell[] = []

		for (const tc of r.children(tr, G.A, "tc")) {
			if (++cells > budgets.cellsPerTable) tooLarge("table cells", budgets.cellsPerTable)

			context.tally.cells++
			context.tally.partCells++

			if (context.tally.partCells > budgets.cellsPerSlide) tooLarge("table cells on a slide", budgets.cellsPerSlide)
			if (context.tally.cells > budgets.cellsPerDeck) tooLarge("table cells in the deck", budgets.cellsPerDeck)

			const txBody = r.child(tc, G.A, "txBody")
			const gridSpan = r.int(tc, "gridSpan")
			const rowSpan = r.int(tc, "rowSpan")
			const props = cellProps(context, r.child(tc, G.A, "tcPr"))

			row.push({
				text: txBody < 0 ? { bodyPr: {}, paragraphs: [] } : readTextBody(context, txBody),
				...(gridSpan !== undefined && gridSpan > 1 ? { gridSpan } : {}),
				...(rowSpan !== undefined && rowSpan > 1 ? { rowSpan } : {}),
				...(r.bool(tc, "hMerge") === true ? { hMerge: true } : {}),
				...(r.bool(tc, "vMerge") === true ? { vMerge: true } : {}),
				...(props === undefined ? {} : { props }),
				src: sourceRef(context, tc)
			})
		}

		rows.push({ h: Math.max(0, r.emu(tr, "h") ?? 0), cells: row })
	}

	const styleId = r.text(r.child(tblPr, G.A, "tableStyleId")).trim()
	const flag = (name: string): boolean => r.bool(tblPr, name) ?? false

	return {
		grid,
		rows,
		...(styleId === "" ? {} : { styleId }),
		flags: {
			firstRow: flag("firstRow"),
			lastRow: flag("lastRow"),
			firstCol: flag("firstCol"),
			lastCol: flag("lastCol"),
			bandRow: flag("bandRow"),
			bandCol: flag("bandCol"),
			...(flag("rtl") ? { rtl: true as const } : {})
		},
		src: sourceRef(context, node)
	}
}
