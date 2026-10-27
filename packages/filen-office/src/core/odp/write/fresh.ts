import { OdfNs, OdfStyleSheet, newOdfPlan, writeManifest } from "../../odf/index"
import { emitFamilyOf } from "../../pptx/write/emit"
import { memorySink, type ByteSink, type PartChange, writeZip, chunksSource } from "../../opc/index"
import { DeckTally, DEFAULT_PRESENTATION_BUDGETS } from "../../presentation/budget"
import { resolveBackground } from "../../presentation/background"
import {
	inheritedShapes,
	resolveParagraph,
	resolveRun,
	resolveShape,
	styleFont,
	type GroupSource,
	type ResolvedShape,
	type SourceDocuments
} from "../../presentation/inherit"
import {
	refused,
	type ColorModel,
	type Deck,
	type EffectList,
	type FillProps,
	type Geometry,
	type LineProps,
	type Paragraph,
	type Refused,
	type Run,
	type RunProps,
	type ShapeNode,
	type SlideNode,
	type SlideRef,
	type SourceRef,
	type TableCell,
	type TableCellProps,
	type TableModel,
	type TextBody
} from "../../presentation/model"
import { builtinTableStyle } from "../../presentation/render/tableStyles"
import { D } from "../../drawingml/reader"
import { resolveColor, themeTypeface, type ColorContext, type PresentationTheme } from "../../presentation/theme"
import { decodeUtf8, encodeUtf8, escapeAttribute } from "../../xml/index"
import { odpTargetId, odpTargetIds, odpTimingMarkup } from "../../anim/odf"
import { withoutShapes } from "../../anim/prune"
import { OdpContext } from "../read/context"
import { openOdp } from "../read/document"
import { IDENTITY, OdpShapeWriter, markupOf, compose, groupAffine, placed, type Affine } from "./emit/shape"
import { pageNames } from "./integrity"
import { OdpStyles, cm, fillChanges, isRefused, setProperty, styleChanges, type OdpWriteEnv } from "./styles"
import { emitOdp, type OdpEmitContext } from "./emit"
import { newSettingsAttributes, odfShow, settingsAttributes } from "./emit/presentation"

// The fresh writer (§1.5.7): a whole ODP package from the model, for conversions (a pptx deck to ODP), templates and
// Save as. Everything a shape inherits is resolved and written on the shape (ODF's presentation styles are not the
// model's chain): its box from its layout or master, its fill, line and shadow, its text with every paragraph and run
// property resolved, theme colours and fonts as the values they stand for. A layout's and its master's shapes that
// paint on slides become the master page of the slides on that layout (one style:master-page per layout used, as
// LibreOffice converts one), its background the master page's. Pictures are copied into Pictures/ from the source.
// What ODF cannot hold as the model has it is written as the nearest form and named in the report (a gradient fill
// as its first colour, an outline ODF has no preset for as a rectangle); what this writer cannot write (charts,
// diagrams, media: their families') is left out and named, never silently. A table is written by the table family
// with its cells' properties and text resolved; PowerPoint's built-in Medium Style 2 (its default, written into a
// cell's properties: ODF table templates are not the model's) as PowerPoint draws it, any other table style named as
// approximated.

const MEDIA_TYPE = "application/vnd.oasis.opendocument.presentation"
const TEMPLATE_MEDIA_TYPE = "application/vnd.oasis.opendocument.presentation-template"

const NAMESPACES = Object.entries({
	office: OdfNs.office,
	style: OdfNs.style,
	text: OdfNs.text,
	table: OdfNs.table,
	draw: OdfNs.draw,
	fo: OdfNs.fo,
	xlink: OdfNs.xlink,
	svg: OdfNs.svg,
	presentation: OdfNs.presentation,
	smil: OdfNs.smil,
	anim: OdfNs.anim,
	script: OdfNs.script,
	dom: "http://www.w3.org/2001/xml-events",
	loext: OdfNs.loext
})
	.map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
	.join(" ")

// What the model leaves in its source, resolved by the reader of that source (a pptx deck: its theme parts and its
// shapes' DrawingML groups).
export interface FreshOdpServices {
	// The source documents levels read their groups from (resolveShape's).
	readonly documents?: SourceDocuments
	// The theme a node's colours and fonts resolve through.
	theme(node: SlideNode): PresentationTheme | undefined
	// A level's property group kept as source markup, read as the model's type; undefined when it cannot be.
	group?(kind: "geometry" | "fill" | "ln" | "effects", src: SourceRef): Geometry | FillProps | LineProps | "none" | EffectList | undefined
	// The fill and line a shape's p:style references give (theme matrix), resolved.
	styleProps?(shape: ShapeNode, node: SlideNode): { readonly fill?: FillProps | "none"; readonly ln?: LineProps | "none" } | undefined
	// A picture's own fill (p:pic's p:blipFill), read as the model's type.
	pictureFill?(shape: ShapeNode): FillProps | undefined
	// A picture part's bytes and media type, copied into the package.
	picture(part: string): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string } | undefined>
}

export interface FreshReport {
	// What was written in a nearer form, by what (counts).
	readonly approximated: Record<string, number>
	// What was left out, by what (counts).
	readonly omitted: Record<string, number>
}

export interface FreshOdp {
	readonly parts: readonly PartChange[]
	readonly mediaType: string
	readonly report: FreshReport
}

function count(table: Record<string, number>, what: string): void {
	table[what] = (table[what] ?? 0) + 1
}

// A colour as ODF holds it (sRGB, its alpha a modifier): theme slots, presets, system colours and modifiers applied.
function srgb(color: ColorModel, context: ColorContext): ColorModel | undefined {
	const resolved = resolveColor(color, context)

	if (resolved === undefined) return undefined

	const alpha = Math.round(resolved.alpha * 100_000)

	return alpha >= 100_000
		? { kind: "srgb", rgb: resolved.hex }
		: { kind: "srgb", rgb: resolved.hex, mods: [{ name: "alpha", value: alpha }] }
}

class Flattener {
	readonly deck: Deck
	readonly services: FreshOdpServices
	readonly report: FreshReport
	readonly pictures = new Map<string, string>()

	constructor(deck: Deck, services: FreshOdpServices, report: FreshReport) {
		this.deck = deck
		this.services = services
		this.report = report
	}

	colorContext(node: SlideNode): ColorContext {
		const background = resolveBackground(this.deck, node)

		return { theme: this.services.theme(node), clrMap: background?.clrMap ?? clrMapOf(this.deck, node) }
	}

	private group<K extends "geometry" | "fill" | "ln" | "effects">(kind: K, source: GroupSource<K> | undefined): unknown {
		if (source === undefined) return undefined
		if (source.kind === "props") return source.value

		return this.services.group?.(kind, source.src)
	}

	fill(value: FillProps | "none" | undefined, colors: ColorContext): FillProps | "none" | undefined {
		if (value === undefined || value === "none") return value

		switch (value.kind) {
			case "solid": {
				const color = srgb(value.color, colors)

				return color === undefined ? undefined : { kind: "solid", color }
			}
			case "gradient": {
				const first = value.stops[0]
				const color = first === undefined ? undefined : srgb(first.color, colors)

				count(this.report.approximated, "gradient fill")

				return color === undefined ? undefined : { kind: "solid", color }
			}
			case "pattern": {
				const color = srgb(value.fg, colors)

				count(this.report.approximated, "pattern fill")

				return color === undefined ? undefined : { kind: "solid", color }
			}
			default:
				count(this.report.omitted, `${value.kind} fill`)

				return undefined
		}
	}

	line(value: LineProps | "none" | undefined, colors: ColorContext): LineProps | "none" | undefined {
		if (value === undefined || value === "none") return value

		const fill = value.fill === undefined ? undefined : this.fill(value.fill, colors)

		if (value.dash !== undefined && value.dash !== "solid") count(this.report.approximated, "dashed line")
		if (value.head !== undefined || value.tail !== undefined) count(this.report.omitted, "line end")

		return {
			...(value.w === undefined ? {} : { w: value.w }),
			...(fill === undefined ? {} : { fill }),
			...(value.cap === undefined ? {} : { cap: value.cap }),
			...(value.join === undefined ? {} : { join: value.join })
		}
	}

	// A shape with everything it inherits on it, colours and fonts as values.
	shape(shape: ShapeNode, node: SlideNode): ShapeNode | undefined {
		if (shape.frame?.kind === "table" && shape.kind === "frame") return this.table(shape, shape.frame.table, node)

		// A diagram laid out (its shapes as children, in the frame's own space) is the group of them.
		if (shape.kind === "frame" && shape.frame?.kind === "smartart" && shape.xfrm !== undefined && (shape.children?.length ?? 0) > 0) {
			const { frame: _frame, ...own } = shape

			return this.shape(
				{ ...own, kind: "grpSp", xfrm: { ...shape.xfrm, chX: 0, chY: 0, chCx: shape.xfrm.cx, chCy: shape.xfrm.cy } },
				node
			)
		}

		if (shape.frame !== undefined && shape.kind === "frame") {
			count(this.report.omitted, `${shape.frame.kind} frame`)

			return undefined
		}

		if (shape.kind === "ink" || shape.kind === "opaque") {
			count(this.report.omitted, shape.kind)

			return undefined
		}

		const resolved = resolveShape(this.deck, node.ref, shape, this.services.documents)
		const colors = this.colorContext(node)
		const style = this.services.styleProps?.(shape, node)
		const fill = this.fill((this.group("fill", resolved.fill) as FillProps | "none" | undefined) ?? style?.fill, colors)
		const ln = this.line((this.group("ln", resolved.ln) as LineProps | "none" | undefined) ?? style?.ln, colors)
		const geometry = this.geometry(this.group("geometry", resolved.geometry) as Geometry | undefined, shape)
		const text = shape.text === undefined ? undefined : this.text(resolved, shape.text, colors, node)
		const children = shape.children?.map(child => this.shape(child, node)).filter(child => child !== undefined)
		// A shape outlined as a line is a line (draw:line).
		const line = geometry?.kind === "preset" && geometry.preset === "line"
		const body = resolved.bodyPr
		const vertical = body.vertical === "horz" || body.vertical === "vert" || body.vertical === "vert270" ? body.vertical : "vert"

		if (vertical !== body.vertical) count(this.report.approximated, `vertical ${body.vertical}`)

		// A shape no level places (a placeholder its layout lacks) stands at the slide's corner with no size, as
		// LibreOffice and PowerPoint place it: kept with its text, never dropped.
		const xfrm =
			resolved.xfrm ?? (shape.kind === "grpSp" ? undefined : { x: 0, y: 0, cx: 0, cy: 0, rot: 0, flipH: false, flipV: false })

		if (resolved.xfrm === undefined && xfrm !== undefined) count(this.report.approximated, "shape without a box")

		const out: ShapeNode = {
			id: shape.id,
			name: shape.name,
			hidden: shape.hidden,
			kind: line && shape.kind === "sp" ? "cxnSp" : shape.kind,
			...(shape.alt === undefined ? {} : { alt: shape.alt }),
			...(xfrm === undefined ? {} : { xfrm }),
			props: {
				...(geometry === undefined ? {} : { geometry }),
				fill: fill ?? "none",
				ln: ln ?? "none",
				bodyPr: { ...body, vertical }
			},
			...(text === undefined ? {} : { text }),
			...(children === undefined ? {} : { children }),
			...(shape.actions?.click === undefined || shape.actions.click.kind === "refused"
				? {}
				: { actions: { click: shape.actions.click } })
		}

		if (shape.kind === "pic") {
			const picture =
				shape.props?.fill ??
				this.services.pictureFill?.(shape) ??
				(this.group("fill", resolved.fill) as FillProps | "none" | undefined)

			out.props = { ...out.props, fill: picture !== undefined && picture !== "none" && picture.kind === "picture" ? picture : "none" }
		}

		return out
	}

	// A table with its cells resolved: the style's look and each cell's own properties as sRGB, its text with every
	// property its chain gives.
	private table(shape: ShapeNode, table: TableModel, node: SlideNode): ShapeNode | undefined {
		const resolved = resolveShape(this.deck, node.ref, shape, this.services.documents)
		const colors = this.colorContext(node)
		const xfrm = resolved.xfrm

		if (xfrm === undefined) {
			count(this.report.omitted, "table frame without a box")

			return undefined
		}

		const look = mediumStyle2(table.styleId)

		if (table.styleId !== undefined && look === undefined) count(this.report.approximated, "table style")

		const solid = (slot: string, mods?: { name: string; value: number }[]): FillProps | undefined => {
			const color = srgb({ kind: "scheme", slot: slot as "accent1", ...(mods === undefined ? {} : { mods }) }, colors)

			return color === undefined ? undefined : { kind: "solid", color }
		}
		const firstBand = table.flags.firstRow ? 1 : 0
		const lastBand = table.flags.lastRow ? table.rows.length - 2 : table.rows.length - 1
		const rows = table.rows.map((row, r) => ({
			h: row.h,
			cells: row.cells.map((cell, c): TableCell => {
				const header = (table.flags.firstRow && r === 0) || (table.flags.lastRow && r === table.rows.length - 1)
				const strong = header || (table.flags.firstCol && c === 0) || (table.flags.lastCol && c === row.cells.length - 1)
				let props: TableCellProps = {}
				let text = this.text(resolved, cell.text, colors, node)

				if (look !== undefined) {
					const banded = table.flags.bandRow && !header && r >= firstBand && r <= lastBand && (r - firstBand) % 2 === 0
					const fill = strong ? solid(look) : solid(look, [{ name: "tint", value: banded ? 40_000 : 20_000 }])
					const white = solid("lt1")
					const edge: LineProps | undefined = white === undefined ? undefined : { w: 12_700, fill: white }

					props = {
						...(fill === undefined ? {} : { fill }),
						...(edge === undefined ? {} : { borders: { l: edge, r: edge, t: edge, b: edge } })
					}

					if (strong) text = strongText(text, white, cell.text)
				}

				const own = cell.props
				const ownFill = own?.fill === undefined ? undefined : this.fill(own.fill, colors)
				const borders: Record<string, LineProps | "none"> = { ...props.borders }

				for (const [side, line] of Object.entries(own?.borders ?? {})) {
					// A cell border has no line ends (§21.1.3.5 a:lnL… take them, nothing draws them).
					const { head: _head, tail: _tail, ...edge } = line === "none" ? { head: undefined, tail: undefined } : line
					const flat = this.line(line === "none" ? "none" : edge, colors)

					if (flat !== undefined) borders[side] = flat
				}

				const { fill: _ownFill, borders: _ownBorders, ...rest } = own ?? {}

				props = {
					...props,
					...rest,
					...(ownFill === undefined ? {} : { fill: ownFill }),
					...(Object.keys(borders).length === 0 ? {} : { borders })
				}

				return {
					text,
					...(cell.gridSpan === undefined ? {} : { gridSpan: cell.gridSpan }),
					...(cell.rowSpan === undefined ? {} : { rowSpan: cell.rowSpan }),
					...(cell.hMerge === undefined ? {} : { hMerge: cell.hMerge }),
					...(cell.vMerge === undefined ? {} : { vMerge: cell.vMerge }),
					...(Object.keys(props).length === 0 ? {} : { props })
				}
			})
		}))

		return {
			id: shape.id,
			name: shape.name,
			hidden: shape.hidden,
			kind: "frame",
			xfrm,
			...(shape.alt === undefined ? {} : { alt: shape.alt }),
			frame: { kind: "table", table: { grid: [...table.grid], rows, flags: { ...table.flags } } }
		}
	}

	private geometry(geometry: Geometry | undefined, shape: ShapeNode): Geometry | undefined {
		if (geometry === undefined) return shape.kind === "sp" ? { kind: "preset", preset: "rect", guides: [] } : undefined
		if (geometry.kind === "preset" && (geometry.preset === "rect" || geometry.preset === "line")) return { ...geometry, guides: [] }
		if (geometry.kind === "preset" && geometry.guides.length === 0 && PRESETS.has(geometry.preset)) return geometry

		count(this.report.approximated, `outline ${geometry.kind === "preset" ? geometry.preset : "custom"}`)

		return shape.kind === "cxnSp" ? { kind: "preset", preset: "line", guides: [] } : { kind: "preset", preset: "rect", guides: [] }
	}

	// A body with every paragraph and run property its chain gives written on it.
	private text(resolved: ResolvedShape, body: TextBody, colors: ColorContext, node: SlideNode): TextBody {
		const theme = this.services.theme(node)
		const font = styleFont(resolved)
		const paragraphs: Paragraph[] = body.paragraphs.map(paragraph => {
			const level = resolveParagraph(resolved, paragraph)
			// Line-breaking rules and the baseline alignment of mixed sizes have no ODF property: ODF's own apply.
			const { defRPr: _defRPr, fontAlgn, eaLnBrk, latinLnBrk, hangingPunct, ...pPr } = level.pPr

			if (fontAlgn !== undefined || eaLnBrk !== undefined || latinLnBrk !== undefined || hangingPunct !== undefined)
				count(this.report.approximated, "line-breaking rules")
			const run = (rPr: RunProps | undefined): RunProps => this.run(resolveRun(level, rPr), colors, theme, font)
			const bullet = pPr.bullet ?? { kind: "none" as const }
			const runs: Run[] = paragraph.runs.flatMap(item => {
				if (item.kind === "opaque") {
					count(this.report.approximated, "run kept as its source")

					return [{ kind: "r", text: item.text, rPr: run(undefined) } as const]
				}

				return [{ ...item, rPr: run(item.rPr) }]
			})
			// Spacing in percent of a line (§21.1.2.2.11: of the line's largest size, a line being 1.2 × the size) has no ODF
			// form: written in points at this paragraph's largest size.
			const largest = Math.max(
				0,
				...runs.map(item => (item.kind === "opaque" ? 0 : (item.rPr.sz ?? 0))),
				resolveRun(level, paragraph.endRPr).sz ?? 0
			)
			const size = largest > 0 ? largest : 1800
			const points = (spacing: typeof pPr.spcBef): typeof pPr.spcBef => {
				if (spacing === undefined || !("pct" in spacing)) return spacing

				count(this.report.approximated, "spacing in percent of a line")

				return { pts: Math.round((spacing.pct / 100_000) * size * 1.2) }
			}
			const spcBef = points(pPr.spcBef)
			const spcAft = points(pPr.spcAft)
			const buClr = pPr.buClr === undefined || pPr.buClr === "text" ? pPr.buClr : srgb(pPr.buClr, colors)
			// A number takes the text's font in ODF; a size in points is written as the share of the paragraph's size.
			const buFont =
				bullet.kind !== "char" || pPr.buFont === undefined || pPr.buFont === "text"
					? undefined
					: { typeface: themeTypeface(theme, pPr.buFont.typeface) ?? pPr.buFont.typeface }
			const buSz =
				pPr.buSz !== undefined && pPr.buSz !== "text" && "pts" in pPr.buSz
					? { pct: Math.round((pPr.buSz.pts / size) * 100_000) }
					: pPr.buSz

			if (buSz !== pPr.buSz) count(this.report.approximated, "bullet size in points")

			const { buFont: _buFont, buSz: _buSz, ...rest } = pPr

			return {
				pPr: {
					...rest,
					...(buSz === undefined ? {} : { buSz }),
					...(spcBef === undefined ? {} : { spcBef }),
					...(spcAft === undefined ? {} : { spcAft }),
					lvl: level.level,
					bullet: this.bullet(bullet),
					...(buClr === undefined ? {} : { buClr }),
					...(buFont === undefined ? {} : { buFont })
				},
				runs,
				endRPr: run(paragraph.endRPr)
			}
		})

		const bodyPr = resolved.bodyPr

		return {
			bodyPr: {
				...bodyPr,
				vertical:
					bodyPr.vertical === "horz" || bodyPr.vertical === "vert" || bodyPr.vertical === "vert270" ? bodyPr.vertical : "vert"
			},
			paragraphs
		}
	}

	// The picture bullets a shape's paragraphs show (their chain gives them), to copy into Pictures/ before it is
	// written.
	bulletPictures(shape: ShapeNode, node: SlideNode): string[] {
		const out: string[] = []
		const walk = (each: ShapeNode): void => {
			if (each.text !== undefined) {
				const resolved = resolveShape(this.deck, node.ref, each, this.services.documents)

				for (const paragraph of each.text.paragraphs) {
					const bullet = resolveParagraph(resolved, paragraph).pPr.bullet

					if (bullet?.kind === "blip" && !this.pictures.has(bullet.part)) out.push(bullet.part)
				}
			}

			for (const child of each.children ?? []) walk(child)
		}

		walk(shape)

		return out
	}

	// A bullet ODF can label: a picture bullet as its picture in Pictures/ (§16.33 text:list-level-style-image), a
	// numbering ODF has no format for as Arabic numbers.
	private bullet(bullet: NonNullable<Paragraph["pPr"]["bullet"]>): NonNullable<Paragraph["pPr"]["bullet"]> {
		if (bullet.kind === "blip") {
			const path = this.pictures.get(bullet.part)

			if (path !== undefined) return { kind: "blip", part: `/${path}` }

			count(this.report.approximated, "picture bullet")

			return { kind: "none" }
		}

		if (bullet.kind === "autoNum" && !NUMBERINGS.test(bullet.scheme)) {
			count(this.report.approximated, `numbering ${bullet.scheme}`)

			return { ...bullet, scheme: "arabicPeriod" }
		}

		return bullet
	}

	private run(
		rPr: RunProps,
		colors: ColorContext,
		theme: PresentationTheme | undefined,
		font: { typeface: string } | undefined
	): RunProps {
		const out: Record<string, unknown> = {}
		const latin = rPr.latin ?? font

		for (const key of ["sz", "b", "i", "u", "strike", "baseline", "cap", "spc"] as const)
			if (rPr[key] !== undefined) out[key] = rPr[key]

		// A language tag as ODF holds one: its language and region (a script or variant is left out).
		const lang = rPr.lang === undefined ? undefined : /^([A-Za-z]{1,8})(?:-(?:[A-Za-z]{4}-)?([A-Za-z]{2}|\d{3}))?/u.exec(rPr.lang)

		if (lang?.[1] !== undefined) out["lang"] = lang[2] === undefined ? lang[1] : `${lang[1]}-${lang[2]}`

		if (latin !== undefined) out["latin"] = { typeface: themeTypeface(theme, latin.typeface) ?? "Arial" }
		if (rPr.ea !== undefined) out["ea"] = { typeface: themeTypeface(theme, rPr.ea.typeface) ?? "Arial" }
		if (rPr.cs !== undefined) out["cs"] = { typeface: themeTypeface(theme, rPr.cs.typeface) ?? "Arial" }

		const fill = rPr.fill === undefined || rPr.fill === "none" ? undefined : this.fill(rPr.fill, colors)

		if (fill !== undefined && fill !== "none" && fill.kind === "solid") {
			const color = fill.color.kind === "srgb" ? { kind: "srgb" as const, rgb: fill.color.rgb } : fill.color

			out["fill"] = { kind: "solid", color }
		}

		if (rPr.highlight !== undefined) {
			const color = srgb(rPr.highlight, colors)

			if (color !== undefined) out["highlight"] = color
		}

		if (rPr.hlinkClick !== undefined && rPr.hlinkClick.kind !== "refused") out["hlinkClick"] = rPr.hlinkClick

		return out as RunProps
	}
}

// The accent slot of a table style of PowerPoint's built-in Medium Style 2 family (render/tableStyles.ts), from its
// whole-table fill; undefined for any other style.
function mediumStyle2(id: string | undefined): string | undefined {
	const style = id === undefined ? undefined : builtinTableStyle(id)

	if (style === undefined) return undefined

	const r = style.reader
	const fill = r.child(r.child(r.child(r.child(style.node, D.A, "wholeTbl"), D.A, "tcStyle"), D.A, "fill"), D.A, "solidFill")

	return r.attr(r.child(fill, D.A, "schemeClr"), "val")
}

// A strong cell's text (a header row, a first column): bold in the style's text colour where the source's runs say
// neither (the style's text properties come before the master's, which the resolved runs carry).
function strongText(body: TextBody, color: FillProps | undefined, source: TextBody): TextBody {
	const strong = (rPr: RunProps, own: RunProps | undefined): RunProps => ({
		...rPr,
		...(own?.b === undefined ? { b: true } : {}),
		...(own?.fill === undefined && color !== undefined ? { fill: color } : {})
	})

	return {
		...body,
		paragraphs: body.paragraphs.map((paragraph, p) => {
			const from = source.paragraphs[p]

			return {
				...paragraph,
				runs: paragraph.runs.map((run, k) => {
					const own = from?.runs[k]

					return run.kind === "opaque"
						? run
						: { ...run, rPr: strong(run.rPr, own === undefined || own.kind === "opaque" ? undefined : own.rPr) }
				}),
				endRPr: strong(paragraph.endRPr ?? {}, from?.endRPr)
			}
		})
	}
}

function clrMapOf(deck: Deck, node: SlideNode): ColorContext["clrMap"] {
	let at: SlideNode | undefined = node

	for (let guard = 0; at !== undefined && guard < 4; guard++) {
		if (at.clrMap !== undefined) return at.clrMap

		at = at.parent === undefined ? undefined : deck.nodes.get(at.parent)
	}

	return DEFAULT_CLR_MAP
}

const DEFAULT_CLR_MAP: ColorContext["clrMap"] = {
	bg1: "lt1",
	tx1: "dk1",
	bg2: "lt2",
	tx2: "dk2",
	accent1: "accent1",
	accent2: "accent2",
	accent3: "accent3",
	accent4: "accent4",
	accent5: "accent5",
	accent6: "accent6",
	hlink: "hlink",
	folHlink: "folHlink"
} as ColorContext["clrMap"]

// Numberings ODF's formats read back as (emit/text.ts SCHEMES).
const NUMBERINGS = /^(arabicPlain|(arabic|alphaLc|alphaUc|romanLc|romanUc)(Period|ParenR|ParenBoth))$/u

// The presets the shape writer has a draw:type for.
const PRESETS: ReadonlySet<string> = new Set([
	"rect",
	"ellipse",
	"roundRect",
	"triangle",
	"rtTriangle",
	"parallelogram",
	"trapezoid",
	"diamond",
	"hexagon",
	"octagon",
	"pentagon",
	"star5",
	"rightArrow",
	"leftArrow",
	"upArrow",
	"downArrow",
	"cloud",
	"heart",
	"smileyFace",
	"donut",
	"plus",
	"frame"
])

const MEDIA_TYPES: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	emf: "image/x-emf",
	wmf: "image/x-wmf",
	tif: "image/tiff",
	tiff: "image/tiff"
}

// The whole package from the model: every slide, layout, master and notes node must be parsed first.
export async function freshOdp(deck: Deck, services: FreshOdpServices): Promise<FreshOdp | Refused> {
	const report: FreshReport = { approximated: {}, omitted: {} }
	const flattener = new Flattener(deck, services, report)
	const sheet = new OdfStyleSheet(undefined, undefined)
	const context = new OdpContext(sheet, DEFAULT_PRESENTATION_BUDGETS, new DeckTally(DEFAULT_PRESENTATION_BUDGETS), new Map(), {
		mediaType: () => undefined,
		has: () => false,
		templates: new Map()
	})
	const names = pageNames(deck, ref => deck.nodes.get(ref)?.name)
	const env = (): OdpWriteEnv => ({
		context,
		stylesFragment: undefined,
		fragmentOf: () => undefined,
		sourceFragment: () => undefined,
		pageName: ref => names.get(ref),
		dispatch: emitOdp,
		familyOf: emitFamilyOf
	})
	const contentStyles = new OdpStyles(env(), "content", new Set())
	const stylesStyles = new OdpStyles(env(), "styles", new Set(["PM1"]))
	const pictures = new Map<string, string>()
	const extra: PartChange[] = []
	const written: string[] = []
	const masterPages = new Map<string, string>()
	const masterMarkup: string[] = []

	// A picture's part copied once into Pictures/.
	const picture = async (part: string): Promise<string | undefined> => {
		const held = pictures.get(part)

		if (held !== undefined) return held

		const read = await services.picture(part)

		if (read === undefined) return undefined

		const extension = /\.([A-Za-z0-9]+)$/u.exec(part)?.[1]?.toLowerCase() ?? "bin"
		const path = `Pictures/${String(pictures.size + 1)}.${extension}`

		pictures.set(part, path)
		extra.push({ name: path, bytes: read.bytes, compress: !/^(png|jpe?g|gif)$/u.test(extension) })

		return path
	}

	// Shapes as markup, flattened; pictures written here (their family is not built for new elements).
	const shapesMarkup = async (
		shapes: readonly { readonly shape: ShapeNode; readonly node: SlideNode }[],
		styles: OdpStyles,
		owner: SlideNode,
		m: Affine = IDENTITY
	): Promise<string | Refused> => {
		const emit: OdpEmitContext = { deck, document: undefined, editor: undefined, styles }
		const writer = new OdpShapeWriter(emit, undefined, owner, () => undefined)
		let out = ""

		for (const { shape, node } of shapes) {
			// Picture bullets are copied before the text that shows them is written.
			for (const part of flattener.bulletPictures(shape, node)) {
				const path = await picture(part)

				if (path !== undefined) flattener.pictures.set(part, path)
			}

			const flat = flattener.shape(shape, node)

			if (flat === undefined) continue

			if (flat.kind === "pic") {
				const fill = flat.props?.fill
				const part = fill !== undefined && fill !== "none" && fill.kind === "picture" ? fill.part : undefined
				const path = part === undefined ? undefined : await picture(part)

				if (path === undefined || flat.xfrm === undefined) {
					count(report.omitted, "picture")

					continue
				}

				const box = placed(flat.xfrm, m)
				const changes = styleChanges()

				fillChanges(changes, "none")
				setProperty(changes, "graphic", "draw:stroke", flat.props?.ln === undefined || flat.props.ln === "none" ? "none" : "solid")

				const style = styles.derived("graphic", undefined, changes)
				const turn = box.rot === 0 ? `svg:x="${cm(box.x)}" svg:y="${cm(box.y)}"` : transformAttributes(box)

				out += `<draw:frame draw:name="${escapeAttribute(flat.name)}" draw:style-name="${escapeAttribute(style)}" ${turn} svg:width="${cm(box.cx)}" svg:height="${cm(box.cy)}"><draw:image xlink:href="${escapeAttribute(path)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>${flat.alt?.descr === undefined ? "" : `<svg:desc>${flat.alt.descr.replace(/&/gu, "&amp;").replace(/</gu, "&lt;")}</svg:desc>`}</draw:frame>`

				continue
			}

			if (flat.kind === "grpSp") {
				const now = groupAffine(flat.xfrm)

				if (isRefused(now)) {
					count(report.omitted, "mirrored group")

					continue
				}

				const inner = await shapesMarkup(
					(shape.children ?? []).map(child => ({ shape: child, node })),
					styles,
					owner,
					compose(m, now)
				)

				if (isRefused(inner)) return inner

				out += `<draw:g${flat.name === "" ? "" : ` draw:name="${escapeAttribute(flat.name)}"`}>${inner}</draw:g>`

				continue
			}

			const pieces = writer.element(flat, m)

			if (isRefused(pieces)) {
				count(report.omitted, `shape (${pieces.detail ?? pieces.reason})`)

				continue
			}

			const markup = markupOf({ kind: "markup", pieces })

			if (isRefused(markup)) return markup

			out += markup
		}

		written.push(out)

		return out
	}

	// The master page of the slides on a layout: the layout's and master's painted shapes, its background.
	const masterPage = async (slide: SlideNode): Promise<string | Refused> => {
		const layout = slide.parent === undefined ? undefined : deck.nodes.get(slide.parent)
		const key = `${String(layout?.ref ?? 0)}\u0000${String(slide.showMasterShapes)}`
		const held = masterPages.get(key)

		if (held !== undefined) return held

		const name = `M${String(masterPages.size + 1)}`
		const levels = inheritedShapes(deck, { ...slide, showMasterShapes: true })
		const shapes = await shapesMarkup(
			levels.map(level => ({ shape: level.shape, node: level.node })),
			stylesStyles,
			layout ?? slide
		)

		if (isRefused(shapes)) return shapes

		const background = resolveBackground(deck, layout ?? slide)
		const changes = styleChanges()

		if (background?.background.kind === "fill") {
			const fill = flattener.fill(background.background.fill, { theme: services.theme(slide), clrMap: background.clrMap })

			for (const [attribute, value] of drawingPageFill(fill)) setProperty(changes, "drawing-page", attribute, value)
		} else if (background !== undefined) {
			count(report.approximated, "background")
		}

		const style = changes.attributes.size === 0 ? undefined : stylesStyles.derived("drawing-page", undefined, changes)

		masterPages.set(key, name)
		masterMarkup.push(
			`<style:master-page style:name="${name}" style:page-layout-name="PM1"${style === undefined ? "" : ` draw:style-name="${style}"`}>${shapes}</style:master-page>`
		)

		return name
	}

	let pages = ""

	for (const ref of deck.slides) {
		const slide = deck.nodes.get(ref)

		if (slide === undefined) return refused("notFound", `slide ${String(ref)} is not parsed`)

		const master = await masterPage(slide)

		if (isRefused(master)) return master

		const shapes = await shapesMarkup(
			slide.shapes.map(shape => ({ shape, node: slide })),
			contentStyles,
			slide
		)

		if (isRefused(shapes)) return shapes

		const changes = styleChanges()
		const own = slide.background === undefined ? undefined : resolveBackground(deck, slide)

		if (own?.background.kind === "fill") {
			const fill = flattener.fill(own.background.fill, { theme: services.theme(slide), clrMap: own.clrMap })

			for (const [attribute, value] of drawingPageFill(fill)) setProperty(changes, "drawing-page", attribute, value)
		}

		if (slide.hidden) setProperty(changes, "drawing-page", "presentation:visibility", "hidden")
		if (!slide.showMasterShapes) setProperty(changes, "drawing-page", "presentation:background-objects-visible", "false")

		const style = changes.attributes.size === 0 ? undefined : contentStyles.derived("drawing-page", undefined, changes)
		let notes = ""
		const notesNode = slide.notes === undefined ? undefined : deck.nodes.get(slide.notes)

		if (notesNode !== undefined) {
			const body = notesNode.shapes.filter(shape => shape.ph?.type === "body")
			const markup = await shapesMarkup(
				body.map(shape => ({ shape, node: notesNode })),
				contentStyles,
				notesNode
			)

			if (isRefused(markup)) return markup
			if (markup !== "") notes = `<presentation:notes>${markup}</presentation:notes>`
		}

		// The slide's timing (after the shapes, before the notes), on the shapes written with the ids it names them by: an
		// effect on a shape the page could not hold goes with it.
		let timing = ""

		if (slide.timing !== undefined) {
			const gone = new Set<number>()

			for (const id of odpTargetIds(slide.timing)) {
				const shape = findShape(slide.shapes, id)

				if (shape === undefined || !shapes.includes(` xml:id="${escapeAttribute(odpTargetId(shape))}"`)) gone.add(id)
			}

			const kept = withoutShapes(slide.timing, gone)

			if (kept !== slide.timing) count(report.omitted, "animation of a shape not written")
			if (kept !== undefined)
				timing = odpTimingMarkup({ fragment: undefined, shapes: slide.shapes }, kept, undefined)
					.map(piece => (typeof piece === "string" ? piece : piece instanceof Uint8Array ? decodeUtf8(piece) : ""))
					.join("")
		}

		pages += `<draw:page draw:name="${escapeAttribute(names.get(ref) ?? "")}"${style === undefined ? "" : ` draw:style-name="${style}"`} draw:master-page-name="${master}">${shapes}${timing}${notes}</draw:page>`
	}

	if (deck.slides.length === 0) {
		const master = await masterPage({
			ref: 0 as SlideRef,
			kind: "slide",
			part: "",
			showMasterShapes: true,
			hidden: false,
			shapes: [],
			comments: [],
			revision: 0
		})

		if (isRefused(master)) return master
	}

	const shows = deck.customShows
		.map(
			show =>
				`<presentation:show presentation:name="${escapeAttribute(show.name)}" presentation:pages="${escapeAttribute(
					show.slides
						.map(ref => names.get(ref))
						.filter(name => name !== undefined)
						.join(",")
				)}"/>`
		)
		.join("")
	const nearest = odfShow(deck, deck.show)

	for (const what of nearest.approximated) count(report.approximated, what)
	for (const what of nearest.omitted) count(report.omitted, what)

	const showAttributes = settingsAttributes(deck, nearest.show, names)

	if (isRefused(showAttributes)) return showAttributes

	const attributes = newSettingsAttributes(showAttributes, "presentation")
	const settings = shows === "" && attributes === "" ? "" : `<presentation:settings${attributes}>${shows}</presentation:settings>`
	const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NAMESPACES} office:version="1.3"><office:automatic-styles>${contentStyles.markup([pages])}</office:automatic-styles><office:body><office:presentation>${pages}${settings}</office:presentation></office:body></office:document-content>`
	const pageLayout = `<style:page-layout style:name="PM1"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" fo:page-width="${cm(deck.size.cx)}" fo:page-height="${cm(deck.size.cy)}" style:print-orientation="${deck.size.cx >= deck.size.cy ? "landscape" : "portrait"}"/></style:page-layout>`
	const styles = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NAMESPACES} office:version="1.3"><office:styles><style:default-style style:family="graphic"><style:graphic-properties draw:fill="none" draw:stroke="none" draw:shadow="hidden"/></style:default-style></office:styles><office:automatic-styles>${pageLayout}${stylesStyles.markup(masterMarkup)}</office:automatic-styles><office:master-styles>${masterMarkup.join("")}</office:master-styles></office:document-styles>`
	const mediaType = deck.variant === "otp" || deck.variant === "potx" || deck.variant === "potm" ? TEMPLATE_MEDIA_TYPE : MEDIA_TYPE
	const manifest = writeManifest("1.3", [
		{ fullPath: "/", mediaType, version: "1.3" },
		{ fullPath: "content.xml", mediaType: "text/xml" },
		{ fullPath: "styles.xml", mediaType: "text/xml" },
		...extra.map(part => ({
			fullPath: part.name,
			mediaType: MEDIA_TYPES[/\.([a-z0-9]+)$/u.exec(part.name)?.[1] ?? ""] ?? "application/octet-stream"
		}))
	])

	return {
		mediaType,
		report,
		parts: [
			{ name: "content.xml", bytes: encodeUtf8(content) },
			{ name: "styles.xml", bytes: encodeUtf8(styles) },
			...extra,
			{ name: "META-INF/manifest.xml", bytes: manifest }
		]
	}
}

// A drawing page's fill (§20.137 on style:drawing-page-properties), as the shape style writes a fill.
function drawingPageFill(fill: FillProps | "none" | undefined): [string, string][] {
	const changes = styleChanges()

	if (fill === undefined) return []

	const failed = fillChanges(changes, fill)

	if (failed !== undefined) return []

	return [...(changes.attributes.get("graphic") ?? [])].filter((entry): entry is [string, string] => entry[1] !== null)
}

function transformAttributes(box: {
	readonly x: number
	readonly y: number
	readonly cx: number
	readonly cy: number
	readonly rot: number
}): string {
	const a = -((box.rot / 60_000) * Math.PI) / 180
	const cos = Math.cos(a)
	const sin = Math.sin(a)
	const halfW = box.cx / 2
	const halfH = box.cy / 2
	const tx = box.x + halfW - (cos * halfW + sin * halfH)
	const ty = box.y + halfH - (-sin * halfW + cos * halfH)

	return `draw:transform="rotate (${a.toFixed(12)}) translate (${cm(tx)} ${cm(ty)})"`
}

// The fresh package written to a sink (mimetype first and stored, Part 2 §3.3), then read back: a package that does
// not open, or opens with another slide count, is refused before the sink is closed.
export async function writeFreshOdp(
	deck: Deck,
	services: FreshOdpServices,
	sink: ByteSink
): Promise<{ readonly report: FreshReport } | Refused> {
	const fresh = await freshOdp(deck, services)

	if (isRefused(fresh)) return fresh

	const memory = memorySink()

	await writeZip(newOdfPlan({ mediaType: fresh.mediaType, parts: fresh.parts }), null, memory)

	const chunks = memory.chunks()
	const back = await openOdp(chunksSource(chunks))

	if (back.kind === "refused") return refused("proofFailed", `the written package does not open: ${back.detail ?? back.reason}`)
	if (back.deck.slides.length !== deck.slides.length) return refused("proofFailed", "the written package has another slide count")

	for (const chunk of chunks) await sink.write(chunk)

	await sink.close()

	return { report: fresh.report }
}

function findShape(shapes: readonly ShapeNode[], id: number): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.id === id) return shape

		const inner = shape.children === undefined ? undefined : findShape(shape.children, id)

		if (inner !== undefined) return inner
	}

	return undefined
}
