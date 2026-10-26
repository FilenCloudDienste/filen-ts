import { readFileSync } from "node:fs"
import { OpcPackage, bytesSource } from "@filen/office/core/opc"
import { D, drawingReader } from "../core/drawingml/reader"
import { parseDataModel, type DataModel } from "../core/smartart/data"
import { layoutDiagram, type Box, type DiagramLayout, type TextMeasurer } from "../core/smartart/interp"
import { parseLayoutDef } from "../core/smartart/layoutDef"
import { parseXml } from "../core/xml/index"

// Scores our SmartArt layout of a package's diagrams against PowerPoint's own cache (dsp:drawing,
// MS-ODRAWXML §1.3.4): our layout runs on the file's data model and embedded layout definition, and
// each cached shape is matched by presentation name and associated data point (prSet
// presName/presAssocID) and scored by the intersection over union of the two boxes.

const DIAGRAM_DRAWING = "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing"

// Average glyph advance and line pitch of a sans face, in ems: enough to fit text sizes where a
// layout sizes boxes from text; the boxes measured here come from constraints.
export const measurer: TextMeasurer = {
	measure(text, fontPt, width) {
		const em = fontPt * 12700
		const advance = em * 0.5
		let lines = 0
		let widest = 0

		for (const paragraph of text.split("\n")) {
			let line = 0

			lines++

			for (const word of paragraph.split(/\s+/u)) {
				const w = (word.length + 1) * advance

				if (line > 0 && line + w > width) {
					lines++
					widest = Math.max(widest, line)
					line = 0
				}

				line += w
			}

			widest = Math.max(widest, line)
		}

		return { width: Math.min(widest, width), height: lines * em * 1.2 }
	}
}

export interface ShapeScore {
	readonly name: string
	readonly iou: number
	readonly cached: Box
	readonly ours: Box | undefined
}

export interface DiagramScore {
	readonly file: string
	readonly slide: string
	readonly layout: string
	readonly shapes: readonly ShapeScore[]
	readonly mean: number
	readonly error?: string
}

export function iou(a: Box, b: Box): number {
	const x0 = Math.max(a.x, b.x)
	const y0 = Math.max(a.y, b.y)
	const x1 = Math.min(a.x + a.w, b.x + b.w)
	const y1 = Math.min(a.y + a.h, b.y + b.h)
	const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
	const union = a.w * a.h + b.w * b.h - inter

	return union > 0 ? inter / union : 0
}

function cachedShapes(bytes: Uint8Array, model: DataModel): { key: string; name: string; box: Box }[] {
	const document = parseXml(bytes)
	const reader = drawingReader(document)
	const presById = new Map(model.pres.map(p => [p.id, p]))
	const out: { key: string; name: string; box: Box }[] = []
	const tree = reader.child(document.documentElement(), D.Dsp, "spTree")

	for (const sp of tree < 0 ? [] : reader.children(tree, D.Dsp, "sp")) {
		const pres = presById.get(reader.attr(sp, "modelId") ?? "")
		const xfrm = reader.child(reader.child(sp, D.Dsp, "spPr"), D.A, "xfrm")
		const off = reader.child(xfrm, D.A, "off")
		const ext = reader.child(xfrm, D.A, "ext")

		if (pres === undefined || off < 0 || ext < 0) continue

		out.push({
			key: `${pres.props.presName ?? ""}\u0000${pres.props.presAssocID ?? ""}`,
			name: pres.props.presName ?? "",
			box: { x: reader.emu(off, "x", 0), y: reader.emu(off, "y", 0), w: reader.emu(ext, "cx", 0), h: reader.emu(ext, "cy", 0) }
		})
	}

	return out
}

export async function scoreFile(
	path: string,
	label: string,
	inspect?: (score: DiagramScore, layout: DiagramLayout) => void
): Promise<DiagramScore[]> {
	const pkg = await OpcPackage.open(bytesSource(readFileSync(path)))
	const out: DiagramScore[] = []
	const slides = [...pkg.entries()].map(e => e.name).filter(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name))

	for (const slide of slides) {
		const document = await pkg.xml(slide)
		const reader = drawingReader(document)
		const rels = await pkg.relationships(slide)

		for (let node = 0; node < document.count; node++) {
			if (!reader.is(node, D.Dgm, "relIds")) continue

			let frame = node

			while (frame >= 0 && document.localName(frame) !== "graphicFrame") frame = document.parent(frame)

			const xfrm = frame < 0 ? -1 : reader.child(frame, reader.group(frame), "xfrm")
			const ext = reader.child(xfrm, D.A, "ext")
			const dm = rels.byId(reader.attrNs(node, D.R, "dm") ?? "")?.partName
			const lo = rels.byId(reader.attrNs(node, D.R, "lo") ?? "")?.partName

			if (dm === undefined || lo === undefined || ext < 0 || !pkg.has(dm) || !pkg.has(lo)) continue

			const dataDoc = await pkg.xml(dm)
			const dataReader = drawingReader(dataDoc)
			const modelExt = dataReader.descendant(dataDoc.documentElement(), D.Dsp, "dataModelExt")
			const relId = dataReader.attr(modelExt, "relId") ?? ""
			const dataRels = await pkg.relationships(dm)
			const drawing = (dataRels.byId(relId) ?? rels.byId(relId) ?? rels.byType(DIAGRAM_DRAWING)[0])?.partName

			if (drawing === undefined || !pkg.has(drawing)) continue

			const layoutDoc = await pkg.xml(lo)
			let layoutName = ""

			try {
				const model = parseDataModel(dataDoc)
				const def = parseLayoutDef(layoutDoc)

				layoutName = def.uniqueId.split("/").pop() ?? ""

				const cached = cachedShapes(await pkg.read(drawing), model)

				if (cached.length === 0) continue

				const ours = layoutDiagram(model, def, reader.emu(ext, "cx", 0), reader.emu(ext, "cy", 0), { measurer })
				const byKey = new Map<string, Box[]>()

				for (const shape of ours.shapes) {
					const key = `${shape.name}\u0000${shape.assocId}`
					const list = byKey.get(key) ?? []

					list.push(shape.box)
					byKey.set(key, list)
				}

				const shapes = cached.map(c => {
					const mine = byKey.get(c.key)?.shift()

					return { name: c.name, iou: mine === undefined ? 0 : iou(mine, c.box), cached: c.box, ours: mine }
				})

				const score = {
					file: label,
					slide,
					layout: layoutName,
					shapes,
					mean: shapes.reduce((s, x) => s + x.iou, 0) / shapes.length
				}

				out.push(score)
				inspect?.(score, ours)
			} catch (error) {
				out.push({ file: label, slide, layout: layoutName, shapes: [], mean: 0, error: String(error) })
			}
		}
	}

	return out
}
