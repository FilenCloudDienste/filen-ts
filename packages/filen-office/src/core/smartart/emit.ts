import { presetProgram } from "../drawingml/geometry/evaluate"
import { D, type DrawingReader } from "../drawingml/reader"
import { Relationships } from "../opc/index"
import { fillOf, readLine, readTextBody, readXfrm, type ReadContext } from "../pptx/read/drawing"
import { styleOf } from "../pptx/read/slide"
import { G, partReader } from "../pptx/read/xml"
import { DeckTally } from "../presentation/budget"
import type { Geometry, ShapeNode } from "../presentation/model"
import { escapeAttribute, escapeText } from "../xml/entities"
import { parseXml } from "../xml/index"
import { connectorRoute, type ConnectorRoute } from "./algorithms/conn"
import { param } from "./algorithms/shared"
import type { DataPoint } from "./data"
import type { Box, DiagramLayout, LaidShape, LayoutNode } from "./interp"
import { DiagramStyles, drawingMarkup, type ShapeStyle } from "./style"

// A laid-out diagram as the drawing PowerPoint caches beside it (MS-ODRAWXML §2.4 dsp:drawing, the part named by
// dsp:dataModelExt@relId), and as the model's shapes. Each laid shape is one dsp:sp: its presentation point's
// modelId, its box and turn, its preset geometry with the layout's adjustments, the style and colour definitions'
// fill, line and references (style.ts), and its text, the data points' own text bodies set at the size layout gave
// them, inside the margins its constraints give. A text-only shape (hidden geometry) drawn on a geometry of the
// same data point becomes that shape's text, its box the text box (dsp:txXfrm), as PowerPoint's caches have it
// (pyramid1's level text on its trapezoid). One-dimensional connectors are their route as a custom path.

const NS_DGM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
const NS_DSP = "http://schemas.microsoft.com/office/drawing/2008/diagram"
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

export interface EmitOptions {
	// The text body a data point holds (its dgm:t), to be written with the diagram's sizes; absent, the point's
	// paragraphs are written as plain runs.
	readonly text?: ((point: DataPoint) => { readonly reader: DrawingReader; readonly node: number } | undefined) | undefined
	// The dgm:spPr a presentation point holds (the user's own fill and line, a picture in a placeholder), written
	// over the style's; its relationship references are the data part's.
	readonly shapeProps?: ((point: DataPoint) => { readonly reader: DrawingReader; readonly node: number } | undefined) | undefined
}

export interface EmittedDiagram {
	readonly shapes: ShapeNode[]
	readonly drawingXml: string
}

function emu(value: number): string {
	return String(Math.round(Number.isFinite(value) ? value : 0))
}

// Layout nodes visited looking for text shapes (the interpreter's own budget bounds the tree well below this).
const MAX_NODES = 200_000

// A text shape merged onto the geometry shape of the same data point that has no text of its own.
interface Drawn {
	readonly shape: LaidShape
	text: LaidShape | undefined
}

function hasText(shape: LaidShape): boolean {
	return shape.text.some(point => point.paragraphs.some(paragraph => paragraph !== ""))
}

function overlaps(a: Box, b: Box): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

// Text nodes with hidden geometry, which the layout's shape list leaves out: they draw only their text.
function textOnly(layout: DiagramLayout): LaidShape[] {
	const out: LaidShape[] = []
	const stack = [layout.root]

	for (let visited = 0; stack.length > 0 && visited < MAX_NODES; visited++) {
		const node = stack.pop() as LayoutNode

		for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as LayoutNode)

		const shape = node.shape

		if (shape?.hideGeom !== true || node.alg.type !== "tx" || !(node.box.w > 0 && node.box.h > 0)) continue
		if (!node.text.some(point => point.paragraphs.some(paragraph => paragraph !== ""))) continue

		out.push({
			name: node.name,
			assocId: node.point.id,
			presId: node.pres?.id,
			box: { ...node.box },
			rot: shape.rot,
			type: shape.type,
			hideGeom: true,
			styleLbl: node.def.styleLbl ?? node.pres?.props.presStyleLbl,
			text: node.text,
			fontPt: node.fontPt,
			node
		})
	}

	return out
}

function plan(layout: DiagramLayout): Drawn[] {
	const out: Drawn[] = []
	const shapes = [...layout.shapes, ...textOnly(layout)]

	for (const shape of shapes) {
		if (shape.hideGeom && hasText(shape)) {
			for (let i = out.length - 1; i >= 0; i--) {
				const host = out[i] as Drawn

				// The host keeps text only from a text node of its own (its alg tx); its other text is presented by this one.
				if (host.shape.hideGeom || (host.text !== undefined && host.text.node.alg.type === "tx")) continue
				if (host.shape.assocId !== shape.assocId || !overlaps(host.shape.box, shape.box)) continue

				host.text = shape

				break
			}

			if (out.some(drawn => drawn.text === shape)) continue
		}

		// A shape's own text is drawn when its node lays text out (tx), or when no text node covers it.
		out.push({ shape, text: hasText(shape) ? shape : undefined })
	}

	return out
}

function geometryMarkup(shape: LaidShape, route: ConnectorRoute | undefined, box: Box): { markup: string; geometry: Geometry } {
	if (route !== undefined && route.dim === "1D") {
		// The route in the box's own coordinates.
		const points = route.points.map(p => ({ x: p.x - box.x, y: p.y - box.y }))
		const first = points[0] ?? { x: 0, y: 0 }
		let path = `<a:moveTo><a:pt x="${emu(first.x)}" y="${emu(first.y)}"/></a:moveTo>`

		if (route.routing === "curve" || route.routing === "longCurve") {
			const last = points[points.length - 1] ?? first
			const a = points[1] ?? first
			const b = points[points.length - 2] ?? last

			path += `<a:cubicBezTo><a:pt x="${emu(a.x)}" y="${emu(a.y)}"/><a:pt x="${emu(b.x)}" y="${emu(b.y)}"/><a:pt x="${emu(last.x)}" y="${emu(last.y)}"/></a:cubicBezTo>`
		} else {
			for (const p of points.slice(1)) path += `<a:lnTo><a:pt x="${emu(p.x)}" y="${emu(p.y)}"/></a:lnTo>`
		}

		return {
			markup: `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="0" b="0"/><a:pathLst><a:path w="${emu(box.w)}" h="${emu(box.h)}" fill="none">${path}</a:path></a:pathLst></a:custGeom>`,
			geometry: { kind: "preset", preset: "line", guides: [] }
		}
	}

	const preset = presetProgram(shape.type) === undefined ? "rect" : shape.type
	const names = presetProgram(preset)?.adjustNames ?? []
	const guides = (shape.node.shape?.adj ?? [])
		.filter(adj => adj.idx >= 1 && adj.idx <= names.length && Number.isFinite(adj.val))
		.map(adj => ({ name: names[adj.idx - 1] as string, formula: `val ${Math.round(adj.val * 100000)}` }))
	const avLst = guides.map(guide => `<a:gd name="${guide.name}" fmla="${guide.formula}"/>`).join("")

	return {
		markup: `<a:prstGeom prst="${escapeAttribute(preset)}"><a:avLst>${avLst}</a:avLst></a:prstGeom>`,
		geometry: { kind: "preset", preset, guides }
	}
}

function anchorOf(shape: LaidShape): { anchor: string; centred: boolean } {
	const vertical = param(shape.node, "txAnchorVert", "mid")
	const horizontal = param(shape.node, "txAnchorHorz", "none")

	return { anchor: vertical === "t" ? "t" : vertical === "b" ? "b" : "ctr", centred: horizontal === "ctr" }
}

const ALIGN: Readonly<Record<string, string>> = { l: "l", r: "r", ctr: "ctr", just: "just" }

// The run properties of `node` (an a:rPr, a:endParaRPr) written again at `size` hundredths of a point.
function runProps(reader: DrawingReader, node: number, size: number | undefined): string {
	const markup = drawingMarkup(reader, node)

	if (size === undefined) return markup

	const name = reader.document.localName(node)
	const open = `<a:${name}`

	return `${open} sz="${size}"${markup.slice(open.length).replace(/^((?:\s+[^\s=/>]+="[^"]*")*?)\s+sz="[^"]*"/u, "$1")}`
}

interface TextLevel {
	readonly level: number
	readonly size: number | undefined
	readonly align: string
	readonly bullet: boolean
}

// One data point's paragraphs: its own text body's, with the diagram's size and alignment.
function paragraphsOf(point: DataPoint, level: TextLevel, options: EmitOptions): string {
	const source = options.text?.(point)
	// A bullet hangs 0.75 of its text size (PowerPoint's caches: 171450 EMU at 18 pt, 228600 at 24 pt).
	const hang = level.size === undefined ? 171450 : Math.round(0.75 * level.size * 127)
	// What PowerPoint's drawings carry where the data sets no spacing (the text was measured with it).
	const defaults: Readonly<Record<string, string>> = {
		lnSpc: '<a:lnSpc><a:spcPct val="90000"/></a:lnSpc>',
		spcBef: '<a:spcBef><a:spcPct val="0"/></a:spcBef>',
		spcAft: `<a:spcAft><a:spcPct val="${level.level === 0 ? "35000" : "15000"}"/></a:spcAft>`
	}
	const spaced = (own: ReadonlyMap<string, string>): string =>
		["lnSpc", "spcBef", "spcAft"].map(name => own.get(name) ?? defaults[name] ?? "").join("")
	// CT_TextParagraphProperties order: spacing, then the bullet, then tabs.
	const pPr = (spacing: string, tabs: string): string =>
		`<a:pPr marL="${level.level > 0 ? emu(level.level * hang) : "0"}" lvl="${level.level}" indent="${level.bullet ? emu(-hang) : "0"}" algn="${level.align}">${spacing}${level.bullet ? '<a:buChar char="•"/>' : "<a:buNone/>"}${tabs}</a:pPr>`

	if (source === undefined) {
		return point.paragraphs
			.map(text => {
				const rPr = level.size === undefined ? '<a:rPr lang="en-US"/>' : `<a:rPr lang="en-US" sz="${level.size}"/>`

				return `<a:p>${pPr(spaced(new Map()), "")}${text === "" ? "" : `<a:r>${rPr}<a:t>${escapeText(text)}</a:t></a:r>`}${rPr.replace("a:rPr", "a:endParaRPr")}</a:p>`
			})
			.join("")
	}

	const { reader, node } = source
	const document = reader.document
	let out = ""

	for (const p of reader.children(node, D.A, "p")) {
		let inner = ""
		const spacing = new Map<string, string>()
		let tabs = ""

		for (let child = document.firstChildElement(p); child >= 0; child = document.nextSiblingElement(child)) {
			if (reader.group(child) !== D.A) continue

			const name = document.localName(child)

			if (name === "pPr") {
				// The paragraph's own properties beyond what the diagram sets (spacing, tabs).
				for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
					const local = document.localName(property)

					if (local === "lnSpc" || local === "spcBef" || local === "spcAft") spacing.set(local, drawingMarkup(reader, property))
					else if (local === "tabLst") tabs = drawingMarkup(reader, property)
				}
			} else if (name === "r" || name === "fld") {
				let run = `<a:${name}`

				for (const attribute of document.attributes(child)) {
					if (!attribute.name.includes(":")) run += ` ${attribute.name}="${escapeAttribute(attribute.value)}"`
				}

				run += ">"

				const rPr = reader.child(child, D.A, "rPr")

				run +=
					rPr >= 0
						? runProps(reader, rPr, level.size)
						: level.size === undefined
							? ""
							: `<a:rPr lang="en-US" sz="${level.size}"/>`

				for (const part of ["pPr", "t"]) {
					const at = reader.child(child, D.A, part)

					if (at >= 0) run += drawingMarkup(reader, at)
				}

				inner += `${run}</a:${name}>`
			} else if (name === "br") {
				const rPr = reader.child(child, D.A, "rPr")

				inner += `<a:br>${rPr >= 0 ? runProps(reader, rPr, level.size) : ""}</a:br>`
			} else if (name === "endParaRPr") {
				inner += runProps(reader, child, level.size)
			}
		}

		out += `<a:p>${pPr(spaced(spacing), tabs)}${inner}</a:p>`
	}

	return out
}

// ST_TextFontSize: hundredths of a point, 1 to 4000 pt.
function fontSize(pt: number): number {
	return Math.min(400000, Math.max(100, Math.round(pt * 100)))
}

function textBody(shape: LaidShape, options: EmitOptions): string {
	const values = shape.node.values
	const margin = (name: string): string => emu(values.get(name) ?? 0)
	const { anchor, centred } = anchorOf(shape)
	const size = shape.fontPt === undefined ? undefined : fontSize(shape.fontPt)
	const secondary = values.get("secFontSz")
	// With the user's own text size (custT: no fitted size) the child runs keep theirs too.
	const childSize =
		shape.fontPt !== undefined && secondary !== undefined && Number.isFinite(secondary) && secondary > 0
			? fontSize(Math.min(secondary, shape.fontPt))
			: size
	const bullets = shape.node.vars.get("bulletEnabled") === "1"
	const align = ALIGN[param(shape.node, "parTxLTRAlign", "ctr")] ?? "ctr"
	const childAlign = ALIGN[param(shape.node, "shpTxLTRAlignCh", "l")] ?? "l"
	const first = shape.text[0]
	let paragraphs = ""

	// Levels count from the shape's own point: a node that presents its children (presOf des) shows them at level 1,
	// bulleted as the text algorithm's stBulletLvl starts them (bList2's child boxes in LibreOffice and PowerPoint).
	const base = first === undefined ? 0 : Math.min(first.depth, shape.node.point.depth)

	shape.text.forEach((point, i) => {
		const level = first === undefined ? 0 : Math.max(i === 0 ? 0 : 1, Math.min(8, point.depth - base))

		paragraphs += paragraphsOf(
			point,
			level === 0 ? { level, size, align, bullet: false } : { level, size: childSize, align: childAlign, bullet: bullets },
			options
		)
	})

	return (
		`<dsp:txBody><a:bodyPr spcFirstLastPara="0" vert="horz" wrap="square" lIns="${margin("lMarg")}" tIns="${margin("tMarg")}" rIns="${margin("rMarg")}" bIns="${margin("bMarg")}" numCol="1" spcCol="1270" anchor="${anchor}" anchorCtr="${centred ? "1" : "0"}"><a:noAutofit/></a:bodyPr>` +
		`<a:lstStyle/>${paragraphs === "" ? '<a:p><a:endParaRPr lang="en-US"/></a:p>' : paragraphs}</dsp:txBody>`
	)
}

function styleMarkup(style: ShapeStyle): string {
	// Office writes a placeholder colour on each reference, the shape's own fill and line coming first; without a
	// colour definition the references carry the colours of Office's default one (accent 1 nodes, light lines).
	const placeholder = '<a:scrgbClr r="0" g="0" b="0"/>'
	const fill = style.fill === undefined ? '<a:schemeClr val="accent1"/>' : placeholder
	const line = style.line === undefined ? '<a:schemeClr val="lt1"/>' : placeholder

	return (
		`<dsp:style><a:lnRef idx="${escapeAttribute(style.lnRef)}">${line}</a:lnRef><a:fillRef idx="${escapeAttribute(style.fillRef)}">${fill}</a:fillRef>` +
		`<a:effectRef idx="${escapeAttribute(style.effectRef)}">${placeholder}</a:effectRef><a:fontRef idx="${style.fontRef}">${style.text ?? ""}</a:fontRef></dsp:style>`
	)
}

// A presentation point's id where the shape has one, else a stable number of its own (ST_ModelId is a GUID or an
// integer).
function modelId(shape: LaidShape, index: number): string {
	return shape.presId ?? String(-(index + 1))
}

function xfrmMarkup(box: Box, rot: number): string {
	// ST_Angle is an integer: a turn that is no finite number is not written.
	const turn = Number.isFinite(rot) ? ((rot % 360) + 360) % 360 : 0
	const angle = Math.round(turn * 60000) % 21600000
	const rotation = angle === 0 ? "" : ` rot="${String(angle)}"`

	return `<a:xfrm${rotation}><a:off x="${emu(box.x)}" y="${emu(box.y)}"/><a:ext cx="${emu(Math.max(0, box.w))}" cy="${emu(Math.max(0, box.h))}"/></a:xfrm>`
}

// The style label counts PowerPoint numbers shapes by (presStyleIdx of presStyleCnt): the presentation point's
// when it has them, else the shape's place among the shapes of its label in drawing order.
function styleIndexes(drawn: readonly Drawn[]): { index: number; total: number }[] {
	const totals = new Map<string, number>()
	const seen = new Map<string, number>()

	for (const { shape } of drawn) totals.set(shape.styleLbl ?? "", (totals.get(shape.styleLbl ?? "") ?? 0) + 1)

	return drawn.map(({ shape }) => {
		const label = shape.styleLbl ?? ""
		const at = seen.get(label) ?? 0
		const props = shape.node.pres?.props

		seen.set(label, at + 1)

		return props?.presStyleIdx !== undefined && props.presStyleCnt !== undefined
			? { index: props.presStyleIdx, total: props.presStyleCnt }
			: { index: at, total: totals.get(label) ?? 1 }
	})
}

const FILLS = new Set(["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"])

// A presentation point's own fill and line (dgm:spPr), as markup; undefined for what it does not set.
function ownProps(pres: DataPoint, options: EmitOptions): { fill: string | undefined; line: string | undefined } | undefined {
	const source = options.shapeProps?.(pres)

	if (source === undefined) return undefined

	const { reader, node } = source
	const document = reader.document
	let fill: string | undefined
	let line: string | undefined

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (reader.group(child) !== D.A) continue

		const name = document.localName(child)

		if (FILLS.has(name)) fill = drawingMarkup(reader, child, 0, true)
		else if (name === "ln") line = drawingMarkup(reader, child, 0, true)
	}

	return fill === undefined && line === undefined ? undefined : { fill, line }
}

function shapeMarkup(item: Drawn, index: number, style: ShapeStyle, options: EmitOptions): string {
	const { shape, text } = item
	const route = connectorRoute(shape.node)
	const line1D = route !== undefined && route.dim === "1D"
	const box = shape.box
	const { markup } = geometryMarkup(shape, route, box)
	const own = shape.node.pres === undefined ? undefined : ownProps(shape.node.pres, options)
	const fill = line1D ? "<a:noFill/>" : shape.hideGeom ? "<a:noFill/>" : (own?.fill ?? style.fill ?? "")
	const ends = line1D ? `${route.begArrow ? '<a:headEnd type="arrow"/>' : ""}${route.endArrow ? '<a:tailEnd type="arrow"/>' : ""}` : ""
	const lineInner = `${style.line ?? ""}${ends}`
	const line =
		shape.hideGeom && !line1D ? "<a:ln><a:noFill/></a:ln>" : (own?.line ?? (lineInner === "" ? "<a:ln/>" : `<a:ln>${lineInner}</a:ln>`))
	const spPr = `<dsp:spPr>${xfrmMarkup(box, shape.rot)}${markup}${fill}${line}${style.scene3d ?? ""}${style.sp3d ?? ""}</dsp:spPr>`
	let body = ""

	if (text !== undefined) {
		body = textBody(text, options)

		// The text's own box when it is not the shape's (a merged text shape, or text kept upright on a turned one).
		if (text !== shape || shape.rot !== 0)
			body += `<dsp:txXfrm>${xfrmMarkup(text.box, 0).replace("<a:xfrm>", "").replace("</a:xfrm>", "")}</dsp:txXfrm>`
	}

	return `<dsp:sp modelId="${escapeAttribute(modelId(shape, index))}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr>${spPr}${styleMarkup(style)}${body}</dsp:sp>`
}

// The model's shapes, read back from the drawing as the slide reader reads a shape.
function modelShapes(drawingXml: string, drawn: readonly Drawn[], geometries: readonly Geometry[]): ShapeNode[] {
	const document = parseXml(new TextEncoder().encode(drawingXml))
	const reader = partReader(document)
	const context: ReadContext = {
		reader,
		part: "",
		epoch: 0,
		relationships: new Relationships([]),
		tally: new DeckTally(),
		action: () => undefined
	}
	const tree = reader.child(document.documentElement(), G.Dsp, "spTree")
	const out: ShapeNode[] = []
	let index = 0

	for (const sp of reader.children(tree, G.Dsp, "sp")) {
		const item = drawn[index]
		const spPr = reader.child(sp, G.Dsp, "spPr")
		const xfrm = readXfrm(reader, reader.child(spPr, G.A, "xfrm"))
		const fill = fillOf(context, spPr)
		const ln = reader.child(spPr, G.A, "ln")
		const style = styleOf(reader, reader.child(sp, G.Dsp, "style"))
		const txBody = reader.child(sp, G.Dsp, "txBody")
		const geometry = geometries[index]

		out.push({
			id: index + 1,
			name: item?.shape.name ?? "",
			hidden: false,
			kind: "sp",
			...(xfrm === undefined ? {} : { xfrm }),
			props: {
				...(geometry === undefined ? {} : { geometry }),
				...(fill === undefined ? {} : { fill }),
				...(ln < 0 ? {} : { ln: readLine(context, ln) })
			},
			...(style === undefined ? {} : { style }),
			...(txBody < 0 ? {} : { text: readTextBody(context, txBody) })
		})
		index++
	}

	return out
}

// The drawing and model shapes of a laid-out diagram.
export function emitDiagram(layout: DiagramLayout, options: EmitOptions = {}): EmittedDiagram {
	const styles = new DiagramStyles(layout.styleDef, layout.colorsDef)
	const drawn = plan(layout)
	const indexes = styleIndexes(drawn)
	const geometries: Geometry[] = []
	let tree = ""

	drawn.forEach((item, i) => {
		const counted = indexes[i] as { index: number; total: number }
		const style = styles.shape(item.shape.styleLbl, counted.index, counted.total)

		geometries.push(geometryMarkup(item.shape, connectorRoute(item.shape.node), item.shape.box).geometry)
		tree += shapeMarkup(item, i, style, options)
	})

	const drawingXml =
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
		`<dsp:drawing xmlns:dgm="${NS_DGM}" xmlns:dsp="${NS_DSP}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">` +
		`<dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>${tree}</dsp:spTree></dsp:drawing>`

	return { shapes: modelShapes(drawingXml, drawn, geometries), drawingXml }
}
