import { appendAll } from "../../arrays"
import type { FreshOdpServices } from "../../odp/write/fresh"
import type { Relationships } from "../../opc/index"
import type { PptxParts } from "../../pptx/package"
import { readBlipFill, readEffects, readFill, readLine, readTextBody, readXfrm, sourceRef, type ReadContext } from "../../pptx/read/drawing"
import { styleOf } from "../../pptx/read/slide"
import { G, partReader } from "../../pptx/read/xml"
import { compileCustomGeometry } from "../../drawingml/geometry/custom"
import { evaluateGuides, textRect } from "../../drawingml/geometry/evaluate"
import { GEOM_COMMAND_ARITY, GeomCommand, PATH_FILL_MASK, PATH_FILL_NAMES, PATH_NO_STROKE } from "../../drawingml/geometry/program"
import { drawingReader, type DrawingReader } from "../../drawingml/reader"
import { drawingTheme, type DrawingTheme } from "../../drawingml/color"
import { presentationChartObject } from "../../odp/write/chartObject"
import { chartDocument, isHeldChart } from "../../presentation/edit/apply/chart"
import { cm } from "../../odp/write/styles"
import { themeFillStyle } from "../../presentation/background"
import { effectiveClrMap, readTheme, themeOf, themeSlot } from "../../presentation/theme"
import {
	PATH_ARC,
	PATH_CLOSE,
	PATH_CUBIC,
	PATH_LINE,
	PATH_MOVE,
	PATH_QUAD,
	type CustomPath,
	type ColorModel,
	type Deck,
	type FillProps,
	type FrameRef,
	type Geometry,
	type LineProps,
	type ShapeNode,
	type SlideNode,
	type StyleMatrixRef,
	type SchemeSlot,
	type TextBody
} from "../../presentation/model"
import { parseXml, type XmlDocument } from "../../xml/index"

// What a PresentationML source gives the fresh ODP writer: its themes, its shapes' DrawingML groups read as the
// model's types, its pictures' bytes, its SmartArt diagrams' shapes. Every slide (and notes page) must be parsed
// first; `preload` reads the relationships of every part the deck has, and every diagram's drawing, once, so the
// writer's reads are synchronous.

export type PptxFreshServices = FreshOdpServices & { preload(): Promise<void> }

type SmartArtFrame = Extract<FrameRef, { kind: "smartart" }>

export interface PptxServicesOptions {
	// A diagram without a drawing cache (or with an empty one) laid out in its w × h EMU frame: its drawing markup
	// (dsp:drawing, MS-ODRAWXML §2.3), whose relationships are its data part's; undefined when it cannot be.
	relayout?(frame: SmartArtFrame, box: { readonly w: number; readonly h: number }, node: SlideNode): Promise<string | undefined>
}

// MS-ODRAWXML §2.3: the shapes of a diagram's drawing are DrawingML shapes in the dsp namespace (dsp:sp with
// dsp:nvSpPr, dsp:spPr, dsp:style, dsp:txBody and dsp:txXfrm, the box of its text; dsp:grpSp), placed in the frame's
// own space.
const MAX_DIAGRAM_DEPTH = 64

interface DiagramRead {
	next: number
	// Shapes left in the slide's budget.
	left: number
}

function diagramShapes(context: ReadContext, tree: number, depth: number, read: DiagramRead): ShapeNode[] {
	const r = context.reader
	const out: ShapeNode[] = []

	if (depth > MAX_DIAGRAM_DEPTH) return out

	for (let node = r.first(tree); node >= 0 && read.left > 0; node = r.next(node)) {
		const local = r.local(node)

		if (r.group(node) !== G.Dsp || (local !== "sp" && local !== "grpSp")) continue

		const group = local === "grpSp"
		const cNvPr = r.child(r.child(node, G.Dsp, group ? "nvGrpSpPr" : "nvSpPr"), G.Dsp, "cNvPr")
		const xfrm = readXfrm(r, r.child(r.child(node, G.Dsp, group ? "grpSpPr" : "spPr"), G.A, "xfrm"))
		const style = styleOf(r, r.child(node, G.Dsp, "style"))
		const txBody = r.child(node, G.Dsp, "txBody")
		const text = txBody < 0 ? undefined : readTextBody(context, txBody)

		read.left--
		out.push({
			id: read.next++,
			name: r.attr(cNvPr, "name") ?? "",
			hidden: false,
			kind: group ? "grpSp" : "sp",
			...(xfrm === undefined ? {} : { xfrm }),
			...(style === undefined ? {} : { style }),
			...(text === undefined
				? {}
				: { text: xfrm === undefined ? text : inTextBox(text, xfrm, readXfrm(r, r.child(node, G.Dsp, "txXfrm"))) }),
			...(group ? { children: diagramShapes(context, node, depth + 1, read) } : {}),
			src: sourceRef(context, node)
		})
	}

	return out
}

const EMU_PER_PX = 9525
// a:bodyPr insets by default (§21.1.2.1.1), px.
const DEFAULT_INSETS = { left: 9.6, top: 4.8, right: 9.6, bottom: 4.8 }

// The text of a shape whose text box (dsp:txXfrm) is not its own box, as insets of its box: the text box's offset
// from the box, in the shape's own (unrotated) frame, added to the body's insets. A text box turned other than the
// shape keeps the body's insets.
function inTextBox(text: TextBody, box: NonNullable<ShapeNode["xfrm"]>, textBox: ShapeNode["xfrm"]): TextBody {
	if (textBox === undefined || textBox.rot !== box.rot) return text

	const angle = (-box.rot / 60_000) * (Math.PI / 180)
	const dx = textBox.x + textBox.cx / 2 - (box.x + box.cx / 2)
	const dy = textBox.y + textBox.cy / 2 - (box.y + box.cy / 2)
	const cx = (box.flipH ? -1 : 1) * (dx * Math.cos(angle) - dy * Math.sin(angle))
	const cy = (box.flipV ? -1 : 1) * (dx * Math.sin(angle) + dy * Math.cos(angle))
	const left = (box.cx - textBox.cx) / 2 + cx
	const top = (box.cy - textBox.cy) / 2 + cy
	const right = box.cx - textBox.cx - left
	const bottom = box.cy - textBox.cy - top
	const own = text.bodyPr.insets
	const inset = (side: keyof typeof DEFAULT_INSETS, offset: number): number => {
		const value = own?.[side]

		return (value === undefined || Number.isNaN(value) ? DEFAULT_INSETS[side] : value) + offset / EMU_PER_PX
	}

	return {
		...text,
		bodyPr: {
			...text.bodyPr,
			insets: { left: inset("left", left), top: inset("top", top), right: inset("right", right), bottom: inset("bottom", bottom) }
		}
	}
}

function maxId(shapes: readonly ShapeNode[], depth: number): number {
	let highest = 0

	if (depth > MAX_DIAGRAM_DEPTH) return highest

	for (const shape of shapes) highest = Math.max(highest, shape.id, shape.children === undefined ? 0 : maxId(shape.children, depth + 1))

	return highest
}

// The SmartArt frames of a level, at any depth of its groups.
function frames(shapes: readonly ShapeNode[], depth: number): ShapeNode[] {
	const out: ShapeNode[] = []

	if (depth > MAX_DIAGRAM_DEPTH) return out

	for (const shape of shapes) {
		if (shape.frame?.kind === "smartart") out.push(shape)
		if (shape.children !== undefined) appendAll(out, frames(shape.children, depth + 1))
	}

	return out
}

// The chart frames of a level, at any depth of its groups.
function chartFrames(shapes: readonly ShapeNode[], depth: number): ShapeNode[] {
	const out: ShapeNode[] = []

	if (depth > MAX_DIAGRAM_DEPTH) return out

	for (const shape of shapes) {
		if (shape.frame?.kind === "chart") out.push(shape)
		if (shape.children !== undefined) appendAll(out, chartFrames(shape.children, depth + 1))
	}

	return out
}

// A drawing's shape tree holds a shape (an empty cache leaves the diagram to its reader).
function hasShapes(document: XmlDocument): boolean {
	const r = partReader(document)
	const tree = r.child(document.documentElement(), G.Dsp, "spTree")

	for (let child = r.first(tree); child >= 0; child = r.next(child))
		if (r.group(child) === G.Dsp && (r.local(child) === "sp" || r.local(child) === "grpSp")) return true

	return false
}

// A theme matrix colour (schemeClr val="phClr") as the referencing colour, the matrix entry's modifiers after it
// (ECMA-376 Part 1 §20.1.4.1.9 fmtScheme: "the color is supplied by the referencing element").
function placed(color: ColorModel, by: ColorModel | undefined): ColorModel {
	if (color.kind !== "scheme" || color.slot !== "phClr" || by === undefined) return color

	const mods = [...(by.mods ?? []), ...(color.mods ?? [])]

	return { ...by, ...(mods.length === 0 ? {} : { mods }) }
}

function placedFill(fill: FillProps | "none" | undefined, by: ColorModel | undefined): FillProps | "none" | undefined {
	if (fill === undefined || fill === "none") return fill

	switch (fill.kind) {
		case "solid":
			return { ...fill, color: placed(fill.color, by) }
		case "gradient":
			return { ...fill, stops: fill.stops.map(stop => ({ ...stop, color: placed(stop.color, by) })) }
		case "pattern":
			return { ...fill, fg: placed(fill.fg, by), bg: placed(fill.bg, by) }
		default:
			return fill
	}
}

// The n-th element of a theme's fmtScheme list (1-based), or -1.
function matrixEntry(document: XmlDocument, list: string, index: number): number {
	const r = partReader(document)
	const scheme = r.child(r.child(document.documentElement(), G.A, "themeElements"), G.A, "fmtScheme")
	let at = 0

	for (let child = r.first(r.child(scheme, G.A, list)); child >= 0; child = r.next(child)) if (++at === index) return child

	return -1
}

export function pptxServices(deck: Deck, parts: PptxParts, options: PptxServicesOptions = {}): PptxFreshServices {
	const contexts = new Map<string, ReadContext>()
	const relationships = new Map<string, Relationships>()
	// Diagram drawings read in preload (cached parts and laid-out markup), by the part name their shapes' src names.
	const drawings = new Map<string, XmlDocument>()
	const diagrams = new WeakMap<ShapeNode, readonly ShapeNode[]>()
	const documentOf = (part: string): XmlDocument | undefined => parts.document(part) ?? drawings.get(part)
	// A diagram's drawing: its cached part when that has shapes, else its layout (options.relayout), read once.
	const drawingOf = async (
		frame: SmartArtFrame,
		xfrm: NonNullable<ShapeNode["xfrm"]>,
		node: SlideNode,
		key: string
	): Promise<{ readonly part: string; readonly document: XmlDocument } | undefined> => {
		const cached = frame.drawing
		const entry = cached === undefined ? undefined : parts.opc.entry(cached)

		if (cached !== undefined && entry !== undefined && entry.uncompressedSize <= parts.tally.budgets.xmlPartBytes) {
			const document = drawings.get(cached) ?? (await parts.opc.xml(cached))

			if (hasShapes(document)) {
				drawings.set(cached, document)

				if (!relationships.has(cached)) relationships.set(cached, await parts.opc.relationships(cached.slice(1)))

				return { part: cached, document }
			}
		}

		const markup = await options.relayout?.(frame, { w: xfrm.cx, h: xfrm.cy }, node)

		if (markup === undefined || !parts.opc.has(frame.data)) return undefined

		// Its shapes' relationships are the data part's; its src names a part of its own.
		const part = `${frame.data}#${node.part}#${key}`
		const document = parseXml(new TextEncoder().encode(markup))

		drawings.set(part, document)
		relationships.set(part, relationships.get(frame.data) ?? (await parts.opc.relationships(frame.data.slice(1))))

		return { part, document }
	}
	// Chart parts, read in preload.
	const charts = new Map<string, XmlDocument>()
	// A level's theme as the drawing layer reads it (its colours through the level's colour map).
	const themeOfNode = (node: SlideNode): DrawingTheme => {
		const theme = themeOf(deck.nodes, node)
		const document = theme === undefined ? undefined : parts.document(theme.part)

		if (theme === undefined || document === undefined) return drawingTheme(undefined, () => undefined)

		const map = effectiveClrMap(deck.nodes, node)
		const colors = (parts.theme(theme.part) ?? readTheme(theme.part, document)).colors

		return drawingTheme(document, name => {
			const slot = themeSlot(name as SchemeSlot, map)

			return slot === undefined ? undefined : colors.get(slot)
		})
	}
	// A level's theme document and its read context.
	const matrixOf = (node: SlideNode): { readonly document: XmlDocument; readonly context: ReadContext } | undefined => {
		const theme = themeOf(deck.nodes, node)
		const document = theme === undefined ? undefined : parts.document(theme.part)
		const context = theme === undefined ? undefined : contextOf(theme.part)

		return document === undefined || context === undefined ? undefined : { document, context }
	}
	const matrixFill = (
		matrix: { readonly document: XmlDocument; readonly context: ReadContext },
		ref: StyleMatrixRef
	): FillProps | "none" | undefined => {
		if (ref.idx === 0 || ref.idx === 1000) return "none"

		const entry = themeFillStyle(matrix.document, ref.idx)

		return entry < 0 ? undefined : placedFill(readFill(matrix.context, entry), ref.color)
	}
	const matrixLine = (
		matrix: { readonly document: XmlDocument; readonly context: ReadContext },
		ref: StyleMatrixRef
	): LineProps | "none" | undefined => {
		if (ref.idx === 0) return "none"

		const entry = matrixEntry(matrix.document, "lnStyleLst", ref.idx)

		if (entry < 0) return undefined

		const line = readLine(matrix.context, entry)

		return { ...line, ...(line.fill === undefined ? {} : { fill: placedFill(line.fill, ref.color) }) } as LineProps
	}
	const contextOf = (part: string): ReadContext | undefined => {
		const held = contexts.get(part)

		if (held !== undefined) return held

		const document = documentOf(part)
		const rels = relationships.get(part)

		if (document === undefined || rels === undefined) return undefined

		const context: ReadContext = {
			reader: partReader(document),
			part,
			epoch: parts.epoch,
			relationships: rels,
			tally: parts.tally,
			action: () => undefined
		}

		contexts.set(part, context)

		return context
	}

	return {
		documents: { document: documentOf },
		theme: node => {
			const theme = themeOf(deck.nodes, node)

			return theme === undefined ? undefined : parts.theme(theme.part)
		},
		group(kind, src, box) {
			if (src.format !== "pptx") return undefined

			const context = contextOf(src.part)

			if (context === undefined) return undefined

			switch (kind) {
				case "fill":
					return readFill(context, src.node)
				case "ln":
					return readLine(context, src.node)
				case "effects":
					return readEffects(context, src.node)
				case "geometry": {
					const reader = context.reader

					if (reader.local(src.node) === "custGeom")
						return box === undefined
							? undefined
							: customGeometry(drawingReader(reader.document, reader.namespaces), src.node, box)
					if (reader.local(src.node) !== "prstGeom") return undefined

					// a:avLst (§20.1.9.5): the preset's adjust values the shape overrides.
					const guides = reader
						.children(reader.child(src.node, G.A, "avLst"), G.A, "gd")
						.map(gd => ({ name: reader.attr(gd, "name") ?? "", formula: reader.attr(gd, "fmla") ?? "" }))
						.filter(guide => guide.name !== "" && guide.formula !== "")
					const geometry: Geometry = { kind: "preset", preset: reader.attr(src.node, "prst") ?? "rect", guides }

					return geometry
				}
			}
		},
		// p:style's fillRef and lnRef (§20.1.4.2.10, .19) through the theme's style matrix: idx 0 is none.
		styleProps(shape, node) {
			const style = shape.style

			if (style === undefined) return undefined

			const matrix = matrixOf(node)

			if (matrix === undefined) return undefined

			const fill = matrixFill(matrix, style.fill)
			const ln = matrixLine(matrix, style.ln)

			return { ...(fill === undefined ? {} : { fill }), ...(ln === undefined ? {} : { ln }) }
		},
		// p:bgRef (§19.3.1.3): idx 1001 on is the theme's bgFillStyleLst, 1–999 its fillStyleLst.
		backgroundFill(idx, color, node) {
			const matrix = matrixOf(node)

			return matrix === undefined ? undefined : matrixFill(matrix, { idx, ...(color === undefined ? {} : { color }) })
		},
		pictureFill(shape) {
			const src = shape.src

			if (src?.format !== "pptx") return undefined

			const context = contextOf(src.part)

			if (context === undefined) return undefined

			const fill = context.reader.child(src.node, G.P, "blipFill")

			return fill < 0 ? undefined : readBlipFill(context, fill)
		},
		async picture(part) {
			if (!parts.opc.has(part)) return undefined

			return { bytes: await parts.opc.read(part), mediaType: parts.contentTypes.typeOf(part.slice(1)) ?? "" }
		},
		diagram: shape => diagrams.get(shape),
		// A chart frame's object (odp/write/chartObject.ts), from its part read in preload, its theme the slide's.
		chart(shape, node) {
			const frame = shape.frame
			// A version the session holds (an inserted or edited chart) before the package's part.
			const document = frame?.kind === "chart" ? (chartDocument(deck, frame.part) ?? charts.get(frame.part)) : undefined

			if (document === undefined || shape.xfrm === undefined) return undefined

			return presentationChartObject(document, themeOfNode(node), cm(shape.xfrm.cx), cm(shape.xfrm.cy))
		},
		preload: async () => {
			for (const node of deck.nodes.values()) {
				const theme = themeOf(deck.nodes, node)?.part

				for (const part of theme === undefined ? [node.part] : [node.part, theme]) {
					if (part === "" || relationships.has(part) || !parts.opc.has(part)) continue

					relationships.set(part, await parts.opc.relationships(part.slice(1)))
				}
			}

			for (const node of deck.nodes.values()) {
				for (const shape of chartFrames(node.shapes, 0)) {
					const part = shape.frame?.kind === "chart" ? shape.frame.part : undefined
					const entry = part === undefined || charts.has(part) || isHeldChart(part) ? undefined : parts.opc.entry(part)

					if (part !== undefined && entry !== undefined && entry.uncompressedSize <= parts.tally.budgets.xmlPartBytes)
						charts.set(part, await parts.opc.xml(part))
				}

				const budget: DiagramRead = { next: maxId(node.shapes, 0) + 1, left: parts.tally.budgets.shapesPerSlide }

				for (const shape of frames(node.shapes, 0)) {
					const frame = shape.frame as SmartArtFrame
					const xfrm = shape.xfrm

					if (xfrm === undefined) continue

					const drawn = await drawingOf(frame, xfrm, node, String(shape.id))

					if (drawn === undefined) continue

					const context = contextOf(drawn.part)
					const root = drawn.document.documentElement()
					const tree = context === undefined ? -1 : context.reader.child(root, G.Dsp, "spTree")

					if (context === undefined || tree < 0) continue

					const children = diagramShapes(context, tree, 0, budget)

					if (children.length > 0) diagrams.set(shape, children)
				}
			}
		}
	}
}

// a:custGeom (§20.1.9.8) as the model's custom outline for a box of `box` EMU: its guides evaluated for the box, each
// path's commands in its own w × h space (the box's EMU without one), its text rectangle in EMU.
function customGeometry(reader: DrawingReader, node: number, box: { readonly cx: number; readonly cy: number }): Geometry {
	const program = compileCustomGeometry(reader, node)
	const w = Math.max(0, box.cx)
	const h = Math.max(0, box.cy)
	const slots = evaluateGuides(program, w, h)
	const value = (arg: number): number => {
		const read = arg >= 0 ? slots[arg] : program.literals[-1 - arg]

		return Number.isFinite(read) ? (read as number) : 0
	}
	const paths: CustomPath[] = []
	const commands = program.paths
	let current: { w: number; h: number; flags: number; commands: number[]; coords: number[] } | undefined
	const finish = (): void => {
		if (current === undefined || current.commands.length === 0) return

		paths.push({
			w: current.w,
			h: current.h,
			fill: (PATH_FILL_NAMES[current.flags & PATH_FILL_MASK] ?? "norm") as CustomPath["fill"],
			stroke: (current.flags & PATH_NO_STROKE) === 0,
			extrusionOk: true,
			commands: Uint8Array.from(current.commands),
			coords: Float64Array.from(current.coords)
		})
	}
	const CODES: Readonly<Record<number, number>> = {
		[GeomCommand.MOVE]: PATH_MOVE,
		[GeomCommand.LINE]: PATH_LINE,
		[GeomCommand.ARC]: PATH_ARC,
		[GeomCommand.QUAD]: PATH_QUAD,
		[GeomCommand.CUBIC]: PATH_CUBIC,
		[GeomCommand.CLOSE]: PATH_CLOSE
	}

	for (let k = 0; k < commands.length;) {
		const command = commands[k] ?? 0
		const arity = GEOM_COMMAND_ARITY[command] ?? 0

		if (command === GeomCommand.PATH) {
			finish()
			current = {
				flags: value(commands[k + 1] ?? 0),
				w: value(commands[k + 2] ?? 0),
				h: value(commands[k + 3] ?? 0),
				commands: [],
				coords: []
			}
		} else if (current !== undefined && CODES[command] !== undefined) {
			current.commands.push(CODES[command] as number)

			for (let a = 1; a <= arity; a++) current.coords.push(value(commands[k + a] ?? 0))
		}

		k += 1 + arity
	}

	finish()

	const [l, t, r, b] = textRect(program, slots, w, h).map(side => String(Math.round(side * EMU_PER_PX)))

	return { kind: "custom", guides: [], paths, textRect: { l: l ?? "0", t: t ?? "0", r: r ?? "0", b: b ?? "0" } }
}
