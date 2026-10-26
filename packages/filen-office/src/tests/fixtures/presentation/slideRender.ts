import { DrawingList, EMU_PER_PX, IDENTITY, ItemKind, rgba, type Paint } from "../../../core/drawingml/index"
import type { Deck, ShapeNode, SlideRef } from "../../../core/presentation/model"
import type { SlideLayer, SlideRender } from "../../../core/presentation/output"
import type { DrawingData } from "../../../dom/docx/protocol"
import { fixtureTextPage } from "./textPage"

// SlideRenders as the presentation worker sends them, built from a fixture deck without a renderer: a background,
// then per shape a rectangle (filled for pictures and tables, outlined for text) and its text page. Placeholders
// without an xfrm take their master's box, as inheritance would.

function rectangle(width: number, height: number, fill: Paint | undefined, stroke: boolean): DrawingData {
	const list = new DrawingList()

	list.width = width
	list.height = height

	const fillIndex = fill === undefined ? -1 : list.paint(fill)
	const strokeIndex = stroke
		? list.stroke({
				width: 1,
				paint: list.paint({ kind: "solid", color: rgba("9CA3AF") }),
				dash: "solid",
				customDash: null,
				cap: "flat",
				join: "miter",
				miterLimit: 8,
				compound: "sng",
				inset: false
			})
		: -1
	const firstCommand = list.commandCount
	const firstCoord = list.coordCount

	list.moveTo(0, 0)
	list.lineTo(width, 0)
	list.lineTo(width, height)
	list.lineTo(0, height)
	list.close()
	list.addItem(ItemKind.PATH, IDENTITY, 0, 0, width, height, firstCommand, firstCoord, fillIndex, strokeIndex, -1, -1, 0, 0)

	const compact = list.compact()

	return {
		width: compact.width,
		height: compact.height,
		commands: compact.commands,
		coords: compact.coords,
		itemCount: compact.itemCount,
		itemFloats: compact.itemFloats,
		itemInts: compact.itemInts,
		paints: compact.paints,
		strokes: compact.strokes,
		images: compact.images,
		texts: compact.texts,
		shadows: compact.shadows
	}
}

function boxOf(deck: Deck, shape: ShapeNode): { x: number; y: number; cx: number; cy: number } {
	if (shape.xfrm !== undefined) return shape.xfrm

	const master = deck.nodes.get(deck.masters[0] ?? (0 as SlideRef))
	const inherited = master?.shapes.find(candidate => candidate.ph?.type === shape.ph?.type)?.xfrm

	return inherited ?? { x: 0, y: 0, cx: deck.size.cx, cy: deck.size.cy }
}

function layerOf(deck: Deck, slide: SlideRef, shape: ShapeNode): SlideLayer {
	const box = boxOf(deck, shape)
	const width = box.cx / EMU_PER_PX
	const height = box.cy / EMU_PER_PX
	const paragraphs = shape.text?.paragraphs.map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join(""))
	const role =
		shape.ph !== undefined ? "placeholder" : shape.kind === "pic" ? "picture" : shape.frame?.kind === "table" ? "table" : "shape"
	const fill: Paint | undefined = role === "picture" || role === "table" ? { kind: "solid", color: rgba("DBEAFE") } : undefined

	return {
		shape: { slide, id: shape.id },
		drawing: rectangle(width, height, fill, fill === undefined),
		...(paragraphs === undefined
			? {}
			: { text: fixtureTextPage(paragraphs, { width, decorated: shape.ph?.type === "title" ? [0] : [] }) }),
		matrix: [1, 0, 0, 1, box.x / EMU_PER_PX, box.y / EMU_PER_PX],
		role,
		...(shape.alt?.descr === undefined ? {} : { alt: shape.alt.descr })
	}
}

export function fixtureSlideRender(deck: Deck, index: number): SlideRender {
	const ref = deck.slides[index]
	const node = ref === undefined ? undefined : deck.nodes.get(ref)

	if (ref === undefined || node === undefined) throw new RangeError(`No slide ${String(index)}`)

	const width = deck.size.cx / EMU_PER_PX
	const height = deck.size.cy / EMU_PER_PX
	const notes = deck.nodes.get(node.notes ?? (0 as SlideRef))

	return {
		ref,
		index,
		revision: node.revision,
		hidden: node.hidden,
		background: rectangle(width, height, { kind: "solid", color: rgba("FFFFFF") }, false),
		layers: node.shapes.map(shape => layerOf(deck, ref, shape)),
		notesText:
			notes?.shapes
				.flatMap(shape => shape.text?.paragraphs ?? [])
				.map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join(""))
				.join("\n") ?? "",
		animated: node.timing !== undefined
	}
}
