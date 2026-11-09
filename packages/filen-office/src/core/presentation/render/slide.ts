import {
	DrawingList,
	IDENTITY,
	ITEM_FLOATS,
	ITEM_INTS,
	ItemFloat,
	ItemInt,
	ItemKind,
	PATH_COMMAND_COORDS,
	PathCommand,
	boxMatrix,
	multiply,
	type TextBodyProps
} from "../../drawingml/displayList"
import type { DrawingData } from "../../drawingml/data"
import type { DrawingTheme } from "../../drawingml/color"
import { D, EMU_PER_PX, drawingReader, type DrawingReader } from "../../drawingml/reader"
import { emitPaths, evaluateGuides } from "../../drawingml/geometry/evaluate"
import { convertShapeTree, shapeGeometry, type ShapeContext } from "../../drawingml/shape"
import { NodeKind, parseXml, sliceClock, type SliceClock, type XmlDocument } from "../../xml/index"
import { runSliced, type Slicing } from "../../slicing"
import { DEFAULT_PRESENTATION_BUDGETS, type PresentationBudgets } from "../budget"
import { bookmarkTriggers } from "../../anim/media"
import { mediaPlayback } from "../edit/apply/media"
import { notesParagraphs, notesText } from "../notes"
import {
	PresentationError,
	type Deck,
	type MediaRef,
	type ShapeNode,
	type SlideNode,
	type SlideRef,
	type TextBody,
	type Xfrm
} from "../model"
import type { LayerRole, ShapeBodyKind, SlideLayer, SlideMediaInfo, SlideRender, TextPage } from "../output"
import { LINE_FLOATS } from "../../text/displayList"
import { turnOf } from "../text/vertical"
import { FLAT, RenderReport, layerEffects } from "./effects"
import { drawFrame, olePicture } from "./frame"
import { SmartArtTexts } from "./smartartText"
import { ScratchWriter, colorXml, effectsXml, fillXml } from "./markup"
import {
	EFFECTS,
	TEXT_MARK,
	hasText,
	levelSource,
	placeholderChain,
	resolveLevels,
	resolvedBodyPr,
	resolvedXfrm,
	writeBlipFill,
	writeProperties,
	writeStyle,
	writeTextMarker,
	writeXfrm,
	type ResolveLevel
} from "./resolve"
import type { PlaceholderLevel, RenderServices, TableTextStyle, TextLayoutRequest } from "./services"
import { finishPictures } from "./pictures"
import { promptBody, type PlaceholderPrompts } from "./prompts"
import { renderTableSteps, type TableRenderInput } from "./table"
import { fitTextWarp, readTextWarp } from "./warp"
import { ThemeCache, levels as chainOf } from "./theme"

// A slide to its SlideRender: the background, then one layer per shape that paints (the master's and the layout's
// own shapes when showMasterSp allows, never their placeholders; then the slide's shapes), each a DrawingData in the
// shape's own box placed by its matrix (rotation in the matrix, flips in the drawing), with its text laid out by the
// text adapter into a TextPage painted once by the text painters. Work yields through `slicing` between shapes.

export const MAX_SHAPES_PER_SLIDE = DEFAULT_PRESENTATION_BUDGETS.shapesPerSlide

// Slides whose resolved elements are kept (the editor's current slide and its neighbours, the rail's window).
const SCRATCH_CACHE = 24

interface TextTarget {
	readonly owner: SlideNode
	readonly shape: ShapeNode
	readonly chain: readonly PlaceholderLevel[]
	readonly body: TextBody
	readonly bodyPr: TextBodyProps
	// Nothing visible in it (no body, or no characters): its layer carries the text box for the editor to enter it,
	// and nothing is laid out for painting.
	readonly empty?: true
}

// The body of a shape without one (read only).
const NO_BODY: TextBody = { bodyPr: {}, paragraphs: [] }

interface Entry {
	readonly owner: SlideNode
	readonly shape: ShapeNode
	readonly role: LayerRole
	readonly levels: readonly ResolveLevel[]
	readonly chain: readonly PlaceholderLevel[]
	// EMU; a zero box at the origin when no level has one (resolvedXfrm).
	readonly xfrm: Xfrm
	// The element's drawing is in slide coordinates (a copied fallback), not its own box.
	readonly slideSpace: boolean
}

// What a render keeps between calls for one host: themes, and the per-slide scratch documents by the revisions they
// were built from.
interface RenderCache {
	readonly themes: ThemeCache
	// Most recently rendered first out last: bounded, so rendering every slide of a long deck keeps a window only.
	readonly scratch: Map<SlideNode, { readonly key: string; readonly built: Scratch }>
}

interface Scratch {
	readonly writer: ScratchWriter
	readonly document: XmlDocument
	readonly entries: readonly Entry[]
	// Per entry: its p:spTree in the scratch document, or -1 (frames).
	readonly trees: readonly number[]
	readonly texts: readonly TextTarget[]
	// Group-nested frames, by the index their placeholder element carries.
	readonly frames: readonly ShapeNode[]
	readonly background: number
	// Per entry: whether a custom geometry in it has more path commands than one shape may (refused, not drawn).
	readonly overPath: readonly boolean[]
}

const caches = new WeakMap<RenderServices, RenderCache>()

function cacheOf(services: RenderServices): RenderCache {
	let cache = caches.get(services)

	if (cache === undefined) {
		cache = { themes: new ThemeCache(services), scratch: new Map() }
		caches.set(services, cache)
	}

	return cache
}

const FRAME_MARK = "foFrame"

function roleOf(owner: SlideNode, shape: ShapeNode): LayerRole {
	if (owner.kind === "master" || owner.kind === "notesMaster" || owner.kind === "handoutMaster") return "master"
	if (owner.kind === "layout") return "layout"
	if (shape.ph !== undefined && shape.kind !== "frame") return "placeholder"

	switch (shape.kind) {
		case "pic":
			return "picture"
		case "grpSp":
			return "group"
		case "ink":
			return "ink"
		case "frame": {
			const kind = shape.frame?.kind

			return kind === "table" || kind === "chart" || kind === "smartart" || kind === "ole" || kind === "media" ? kind : "shape"
		}
		default:
			return "shape"
	}
}

// The shapes that paint on `node`, back to front, with their owners.
function paintingShapes(deck: Deck, node: SlideNode): { owner: SlideNode; shape: ShapeNode }[] {
	const out: { owner: SlideNode; shape: ShapeNode }[] = []
	const chain = chainOf(deck, node)
	const inherited = chain.slice(1)

	// Each inherited level shows when every level below it allows master shapes (a slide's showMasterSp hides its
	// layout's and its master's shapes; a layout's hides its master's).
	for (let k = inherited.length - 1; k >= 0; k--) {
		const level = inherited[k]

		if (level === undefined) continue

		let shown = true

		for (let below = 0; below <= k; below++) if (chain[below]?.showMasterShapes === false) shown = false

		if (!shown) continue

		for (const shape of level.shapes) if (shape.ph === undefined && !shape.hidden) out.push({ owner: level, shape })
	}

	for (const shape of node.shapes) if (!shape.hidden) out.push({ owner: node, shape })

	return out
}

function slideXfrm(deck: Deck): Xfrm {
	return { x: 0, y: 0, cx: deck.size.cx, cy: deck.size.cy, rot: 0, flipH: false, flipV: false }
}

function writeChildren(
	writer: ScratchWriter,
	deck: Deck,
	services: RenderServices,
	owner: SlideNode,
	shapes: readonly ShapeNode[],
	texts: TextTarget[],
	frames: ShapeNode[],
	depth: number
): void {
	if (depth > 128) return

	for (const member of shapes) {
		if (member.hidden) continue

		const child = olePicture(services, member) ?? member
		const levels = resolveLevels(services, owner, child, [])
		const xfrm = child.xfrm

		if (xfrm === undefined) continue

		writeElement(writer, deck, services, owner, child, levels, [], xfrm, false, texts, frames, depth + 1, false)
	}
}

// Presets drawn from the box's top-left to its bottom-right corner (ECMA-376 Part 1 §20.1.10.56 ST_ShapeType: line
// and the connectors), whose ends the editor drags.
const LINE_PRESETS: ReadonlySet<string> = new Set([
	"line",
	"straightConnector1",
	"bentConnector2",
	"bentConnector3",
	"bentConnector4",
	"bentConnector5",
	"curvedConnector2",
	"curvedConnector3",
	"curvedConnector4",
	"curvedConnector5"
])

// The text body a shape holds (textSeedOf's rule: an sp's, a table's per cell; a picture, group or other frame none).
function bodyKindOf(shape: ShapeNode): ShapeBodyKind | undefined {
	if (shape.kind === "frame") return shape.frame?.kind === "table" ? "table" : undefined
	if (shape.kind !== "sp") return undefined

	return shape.ph !== undefined ? "placeholder" : shape.txBox === true ? "textBox" : "shape"
}

// Presets whose stroke is the segment between the line's two ends.
const STRAIGHT_PRESETS: ReadonlySet<string> = new Set(["line", "straightConnector1"])
// Steps a cubic or quadratic of a line's stroke is flattened into for hit testing.
const STROKE_CURVE_STEPS = 12
const strokeScratch = new DrawingList()

// Whether an entry draws as a line between two ends (a connector, or a shape whose resolved geometry, as written to
// the scratch tree, is a line preset), and for one whose stroke is not that segment (an elbow, a curve, a connector's
// own geometry) the stroke as a polyline: x y pairs in EMU of the box before its turn and flips.
function lineOf(
	entry: Entry,
	reader: DrawingReader,
	document: XmlDocument,
	tree: number,
	xfrm: Xfrm
): { readonly path?: number[] } | undefined {
	const connector = entry.shape.kind === "cxnSp"

	if (!connector && (entry.shape.kind !== "sp" || tree < 0)) return undefined

	const spPr = tree < 0 ? -1 : reader.child(document.firstChildElement(tree), D.P, "spPr")
	const preset = reader.attr(reader.child(spPr, D.A, "prstGeom"), "prst")

	if (!connector && (preset === undefined || !LINE_PRESETS.has(preset))) return undefined
	// A connector with no geometry of its own, or a straight one, draws the segment.
	if (spPr < 0 || (preset !== undefined ? STRAIGHT_PRESETS.has(preset) : reader.child(spPr, D.A, "custGeom") < 0)) return {}

	const { program, adjust } = shapeGeometry(reader, spPr)
	const list = strokeScratch

	list.rewindPath(0, 0)
	emitPaths(list, program, evaluateGuides(program, xfrm.cx, xfrm.cy, adjust), xfrm.cx, xfrm.cy)

	const path: number[] = []
	const coords = list.coords
	let at = 0
	let x = 0
	let y = 0
	let startX = 0
	let startY = 0
	const to = (nx: number, ny: number): void => {
		path.push(nx * EMU_PER_PX, ny * EMU_PER_PX)
		x = nx
		y = ny
	}

	for (let k = 0; k < list.commandCount; k++) {
		const command = list.commands[k]

		if (command === PathCommand.MOVE) {
			// A new subpath: a gap in the polyline (NaN pair), then its start.
			if (path.length > 0) path.push(Number.NaN, Number.NaN)

			to(coords[at] ?? 0, coords[at + 1] ?? 0)
			startX = x
			startY = y
		} else if (command === PathCommand.LINE) to(coords[at] ?? 0, coords[at + 1] ?? 0)
		else if (command === PathCommand.CLOSE) to(startX, startY)
		else if (command === PathCommand.CUBIC || command === PathCommand.QUAD) {
			const cubic = command === PathCommand.CUBIC
			const x0 = x
			const y0 = y
			const x1 = coords[at] ?? 0
			const y1 = coords[at + 1] ?? 0
			const x2 = cubic ? (coords[at + 2] ?? 0) : 0
			const y2 = cubic ? (coords[at + 3] ?? 0) : 0
			const x3 = coords[at + (cubic ? 4 : 2)] ?? 0
			const y3 = coords[at + (cubic ? 5 : 3)] ?? 0

			for (let step = 1; step <= STROKE_CURVE_STEPS; step++) {
				const t = step / STROKE_CURVE_STEPS
				const u = 1 - t

				if (cubic) {
					to(
						u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
						u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
					)
				} else to(u * u * x0 + 2 * u * t * x1 + t * t * x3, u * u * y0 + 2 * u * t * y1 + t * t * y3)
			}
		}

		at += PATH_COMMAND_COORDS[command ?? 0] ?? 0
	}

	list.rewindPath(0, 0)

	return path.length >= 4 ? { path } : {}
}

// One resolved element. `local`: the top-level element in its own box (offset and rotation in the layer matrix).
// `editable`: a top-level shape of the rendered node (what the editor enters), so one with no visible text still gets
// its text box (a group's children are not entered: they keep one layer for the group's drawing).
function writeElement(
	writer: ScratchWriter,
	deck: Deck,
	services: RenderServices,
	owner: SlideNode,
	shape: ShapeNode,
	levels: readonly ResolveLevel[],
	chain: readonly PlaceholderLevel[],
	xfrm: Xfrm,
	local: boolean,
	texts: TextTarget[],
	frames: ShapeNode[],
	depth: number,
	editable: boolean
): void {
	const source = levels[0]?.source
	// A shape drawn from its Fallback (math): its text is the Fallback picture.
	const fallback = source !== undefined && shape.src?.format === "pptx" && source.element !== shape.src.node
	const text = (): void => {
		if (fallback) return

		const empty = shape.text === undefined || !hasText(shape)

		if (empty && (!editable || shape.kind !== "sp")) return

		const bodyPr = resolvedBodyPr(deck, owner, shape)

		texts.push({ owner, shape, chain, body: shape.text ?? NO_BODY, bodyPr, ...(empty ? { empty } : {}) })
		writeTextMarker(writer, texts.length - 1, bodyPr)
	}

	switch (shape.kind) {
		case "grpSp": {
			writer.push("<p:grpSp><p:grpSpPr>")
			writeXfrm(writer, xfrm, local)

			const fill = shape.props?.fill

			if (fill !== undefined) writer.push(fillXml(fill, () => undefined))
			else if (source !== undefined) {
				const node = source.reader.childOf(
					source.properties,
					D.A,
					new Set(["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"])
				)

				if (node >= 0) writer.copy(source.reader, source.part, node)
			}

			// The group's effects (EG_EffectProperties after the fill), drawn around the whole group.
			const effects = shape.props?.effects

			if (effects !== undefined && effects.src === undefined) writer.push(effectsXml(effects))
			else if (source !== undefined) {
				const node = source.reader.childOf(source.properties, D.A, EFFECTS)

				if (node >= 0) writer.copy(source.reader, source.part, node)
			}

			writer.push("</p:grpSpPr>")
			writeChildren(writer, deck, services, owner, shape.children ?? [], texts, frames, depth)
			writer.push("</p:grpSp>")

			return
		}
		case "pic":
			writer.push("<p:pic>")
			writeBlipFill(writer, levels)
			writeProperties(writer, levels, xfrm, local)
			writeStyle(writer, levels)
			writer.push("</p:pic>")

			return
		case "frame":
			frames.push(shape)
			writer.push(`<p:graphicFrame ${FRAME_MARK}="${String(frames.length - 1)}"><p:xfrm>`)
			writer.push(
				`<a:off x="${String(Math.round(local ? 0 : xfrm.x))}" y="${String(Math.round(local ? 0 : xfrm.y))}"/><a:ext cx="${String(Math.round(xfrm.cx))}" cy="${String(Math.round(xfrm.cy))}"/>`
			)
			writer.push("</p:xfrm></p:graphicFrame>")

			return
		case "ink":
		case "opaque": {
			// Drawn from its source's drawable branch (an ink Fallback picture), as written.
			if (source !== undefined && reader(source).local(source.element) !== "contentPart")
				writer.copy(source.reader, source.part, source.element)

			return
		}
		default:
			writer.push("<p:sp>")
			writeProperties(writer, levels, xfrm, local)
			writeStyle(writer, levels)
			text()
			writer.push("</p:sp>")
	}
}

function reader(source: { readonly reader: DrawingReader }): DrawingReader {
	return source.reader
}

function backgroundMarkup(writer: ScratchWriter, services: RenderServices, deck: Deck, node: SlideNode): void {
	const xfrm = slideXfrm(deck)

	writer.push("<p:spTree><p:sp><p:spPr>")
	writeXfrm(writer, xfrm, true)
	writer.push('<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>')

	const level = chainOf(deck, node).find(candidate => candidate.background !== undefined)
	const background = level?.background
	let style = ""

	if (background === undefined) {
		writer.push('<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>')
	} else if (background.kind === "fill") {
		const src = background.src
		const document = src?.format === "pptx" ? services.xml(src.part) : undefined
		let copied = false

		if (src !== undefined && document !== undefined && src.node > 0 && src.node < document.count) {
			const sourceReader = drawingReader(document)
			const holder = sourceReader.is(src.node, D.P, "bg") ? sourceReader.child(src.node, D.P, "bgPr") : src.node
			const fill = sourceReader.childOf(holder, D.A, new Set(["noFill", "solidFill", "gradFill", "blipFill", "pattFill"]))

			if (fill >= 0) copied = writer.copy(sourceReader, src.part, fill)
		}

		if (!copied)
			writer.push(
				fillXml(background.fill, fill =>
					fill.part !== undefined
						? writer.target(fill.part)
						: fill.inserted !== undefined
							? writer.target(`inserted:${String(fill.inserted)}`)
							: undefined
				)
			)
	} else {
		style = `<p:style><a:lnRef idx="0"/><a:fillRef idx="${String(background.idx)}">${background.color === undefined ? "" : colorXml(background.color)}</a:fillRef><a:effectRef idx="0"/><a:fontRef idx="minor"/></p:style>`
	}

	writer.push(`</p:spPr>${style}</p:sp></p:spTree>`)
}

function buildScratch(deck: Deck, node: SlideNode, services: RenderServices): Scratch {
	const writer = new ScratchWriter(services)
	const entries: Entry[] = []
	const texts: TextTarget[] = []
	const frames: ShapeNode[] = []
	const painting = paintingShapes(deck, node)

	const budgets = budgetsOf(services)

	if (painting.length > budgets.shapesPerSlide) throw new PresentationError("tooLarge", "shapes per slide")

	backgroundMarkup(writer, services, deck, node)

	for (const painted of painting) {
		const owner = painted.owner
		const shape = olePicture(services, painted.shape) ?? painted.shape
		const chain = owner === node ? placeholderChain(deck, owner, shape) : []
		const levels = resolveLevels(services, owner, shape, chain)
		const slideSpace = (shape.kind === "ink" || shape.kind === "opaque") && levels[0]?.source !== undefined
		const xfrm = slideSpace ? slideXfrm(deck) : resolvedXfrm(levels)
		const entry: Entry = { owner, shape, role: roleOf(owner, painted.shape), levels, chain, xfrm, slideSpace }

		entries.push(entry)

		if (shape.kind === "frame") continue

		writer.push("<p:spTree>")
		writeElement(writer, deck, services, owner, shape, levels, chain, xfrm, !slideSpace, texts, frames, 0, owner === node)
		writer.push("</p:spTree>")
	}

	const document = parseXml(new TextEncoder().encode(writer.finish()))
	const root = document.documentElement()
	const background = document.firstChildElement(root)
	const trees: number[] = []
	const overPath: boolean[] = []
	const reader = drawingReader(document)
	let tree = document.nextSiblingElement(background)
	let slideCommands = 0

	for (const entry of entries) {
		if (entry.shape.kind === "frame") {
			trees.push(-1)
			overPath.push(false)
		} else {
			const next = document.nextSiblingElement(tree)
			const most = mostPathCommands(document, reader, tree, next < 0 ? document.count : next)
			const over = most.shape > budgets.pathCommandsPerShape

			trees.push(tree)
			overPath.push(over)

			if (!over) slideCommands += most.total

			tree = next
		}
	}

	// Counted from the markup, before any geometry is evaluated into the display list.
	if (slideCommands > budgets.pathCommandsPerSlide) throw new PresentationError("tooLarge", "path commands on a slide")

	return { writer, document, entries, trees, texts, frames, background, overPath }
}

function budgetsOf(services: RenderServices): PresentationBudgets {
	return services.budgets ?? DEFAULT_PRESENTATION_BUDGETS
}

// The custom-geometry path commands (a:custGeom/a:pathLst/a:path children, §20.1.9.8) of the nodes [from, to): the
// most in one geometry, and all of them.
function mostPathCommands(
	document: XmlDocument,
	reader: DrawingReader,
	from: number,
	to: number
): { readonly shape: number; readonly total: number } {
	let shape = 0
	let total = 0

	for (let node = from; node < to; node++) {
		if (document.kinds[node] !== NodeKind.Element || !reader.is(node, D.A, "pathLst")) continue

		let commands = 0

		for (let path = document.firstChildElement(node); path >= 0; path = document.nextSiblingElement(path)) {
			for (let command = document.firstChildElement(path); command >= 0; command = document.nextSiblingElement(command)) commands++
		}

		shape = Math.max(shape, commands)
		total += commands
	}

	return { shape, total }
}

function revisionKey(deck: Deck, node: SlideNode): string {
	return [
		deck.revision,
		...chainOf(deck, node).map(level => `${String(level.ref)}:${String(level.revision)}:${String(level.theme?.revision ?? "")}`)
	].join("/")
}

export function drawingData(list: DrawingList): DrawingData {
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
		shadows: compact.shadows,
		...(compact.itemClips === null ? {} : { clips: compact.clips, itemClips: compact.itemClips }),
		...(compact.background === undefined ? {} : { background: compact.background })
	}
}

function emptyDrawing(width: number, height: number): DrawingData {
	const list = new DrawingList()

	list.width = width
	list.height = height

	return drawingData(list)
}

// The text box of a story item: its rectangle inside the insets, turned as turnOf turns the body (vert, eaVert and
// mongolianVert by 90°, vert270 by 270°; §21.1.2.1.1 vert, §20.1.10.83).
export function textBox(
	item: readonly number[],
	x: number,
	y: number,
	w: number,
	h: number,
	body: TextBodyProps
): { readonly matrix: number[]; readonly width: number; readonly height: number } {
	const ix = x + body.insets.left
	const iy = y + body.insets.top
	const iw = Math.max(0, w - body.insets.left - body.insets.right)
	const ih = Math.max(0, h - body.insets.top - body.insets.bottom)

	const turn = turnOf(body.vertical)

	if (turn === 90) return { matrix: multiply(item, [0, 1, -1, 0, ix + iw, iy]), width: ih, height: iw }
	if (turn === 270) return { matrix: multiply(item, [0, -1, 1, 0, ix, iy + ih]), width: ih, height: iw }

	return { matrix: multiply(item, [1, 0, 0, 1, ix, iy]), width: iw, height: ih }
}

export interface RenderOptions {
	// The editor's view: a slide's empty placeholders carry their prompt (SlideLayer.prompt) in these strings.
	readonly prompts?: PlaceholderPrompts
}

// Renders one slide (or a layout or master on its own). The deck's nodes for the slide, its layout, master and notes
// are parsed (parse before touch). `report` collects what was approximated or not drawn.
export async function renderSlide(
	deck: Deck,
	ref: SlideRef,
	services: RenderServices,
	slicing: Slicing,
	report: RenderReport = new RenderReport(),
	options: RenderOptions = {}
): Promise<SlideRender> {
	const clock = sliceClock(slicing)

	// An edit landing during a pause changes what was read: the render starts over on the new state.
	for (let attempt = 0; attempt < MAX_RESTARTS; attempt++) {
		const render = await renderOnce(deck, ref, services, clock, report, options)

		if (render !== undefined) return render
	}

	throw new PresentationError("stale", "the slide kept changing while it rendered")
}

const MAX_RESTARTS = 4

async function renderOnce(
	deck: Deck,
	ref: SlideRef,
	services: RenderServices,
	clock: SliceClock,
	report: RenderReport,
	options: RenderOptions
): Promise<SlideRender | undefined> {
	const node = deck.nodes.get(ref)

	if (node === undefined) throw new PresentationError("notFound", "slide not parsed")

	const cache = cacheOf(services)
	const key = revisionKey(deck, node)
	let cached = cache.scratch.get(node)

	cache.scratch.delete(node)

	if (cached?.key !== key) cached = { key, built: buildScratch(deck, node, services) }

	cache.scratch.set(node, cached)

	for (const oldest of cache.scratch.keys()) {
		if (cache.scratch.size <= SCRATCH_CACHE) break

		cache.scratch.delete(oldest)
	}

	const scratch = cached.built
	const theme = cache.themes.of(deck, node)
	const scratchReader = drawingReader(scratch.document)
	const images = (id: string): ReturnType<ScratchWriter["image"]> => scratch.writer.image(id)
	const backgroundList = new DrawingList()

	convertShapeTree(
		{ list: backgroundList, theme, images, effects: false },
		scratch.document,
		scratch.background,
		deck.size.cx,
		deck.size.cy
	)

	const background = (await finishPictures(backgroundList, services, report)).list
	const layers: SlideLayer[] = []
	const tally = new DrawingTally(budgetsOf(services))

	tally.add(background.itemCount, background.commandCount)

	for (let k = 0; k < scratch.entries.length; k++) {
		const entry = scratch.entries[k]

		if (entry === undefined) continue

		const first = layers.length

		if (scratch.overPath[k] === true) {
			report.refuse("custGeom:tooLarge")
			layers.push({
				...layerBase(entry, entry.shape.id),
				drawing: emptyDrawing(entry.xfrm.cx / EMU_PER_PX, entry.xfrm.cy / EMU_PER_PX),
				matrix: entryMatrix(entry)
			})
		} else {
			await renderEntry(
				deck,
				node,
				entry,
				scratch,
				scratch.trees[k] ?? -1,
				scratchReader,
				theme,
				services,
				clock,
				report,
				layers,
				// Prompts are a slide's own (never a layout's or master's on their own render).
				node.kind === "slide" ? options.prompts : undefined
			)
		}

		// The slide's own shapes carry their box for the editor (every layer the entry made, overlays included).
		if (entry.owner === node) {
			const shape = entry.shape
			const body = bodyKindOf(shape)
			const line = lineOf(entry, scratchReader, scratch.document, scratch.trees[k] ?? -1, entry.xfrm)
			const box = {
				id: shape.id,
				xfrm: { ...entry.xfrm },
				...(shape.alt === undefined ? {} : { alt: { ...shape.alt } }),
				...(shape.locks === undefined ? {} : { locks: shape.locks }),
				...(line === undefined ? {} : { line: true as const }),
				...(line?.path === undefined ? {} : { path: line.path }),
				...(body === undefined ? {} : { body })
			}

			for (let layer = first; layer < layers.length; layer++) layers[layer] = { ...(layers[layer] as SlideLayer), box }
		}

		for (let layer = first; layer < layers.length; layer++) tally.layer(layers[layer]?.drawing)

		if (clock.due) {
			await clock.pause()

			if (deck.nodes.get(ref) !== node || revisionKey(deck, node) !== key) return undefined
		}
	}

	const notes = notesParagraphs(deck, node)

	return {
		ref,
		index: deck.slides.indexOf(ref),
		revision: node.revision,
		hidden: node.hidden,
		...(node.parent === undefined ? {} : { layout: node.parent }),
		...(node.showMasterShapes ? {} : { hidesMasterShapes: true as const }),
		background: drawingData(background),
		layers,
		notesText: notesText(deck, node),
		...(notes === undefined ? {} : { notes }),
		animated: node.timing !== undefined
	}
}

// The display items and path commands a slide's layers hold, refused past the per-slide budgets as each shape is
// drawn (one shape's own work is bounded by its own budgets).
class DrawingTally {
	private items = 0
	private commands = 0
	// Layers cut from one drawing share its command arrays: each is counted once.
	private last: Uint8Array | undefined
	private readonly budgets: PresentationBudgets

	constructor(budgets: PresentationBudgets) {
		this.budgets = budgets
	}

	layer(drawing: DrawingData | undefined): void {
		if (drawing === undefined) return

		const shared = drawing.commands === this.last

		this.last = drawing.commands
		this.add(drawing.itemCount, shared ? 0 : drawing.commands.length)
	}

	add(items: number, commands: number): void {
		this.items += items
		this.commands += commands

		if (this.items > this.budgets.displayItemsPerSlide) throw new PresentationError("tooLarge", "display items on a slide")
		if (this.commands > this.budgets.pathCommandsPerSlide) throw new PresentationError("tooLarge", "path commands on a slide")
	}
}

// The layer matrix of an element: its offset and rotation, or none for a drawing in slide coordinates.
function entryMatrix(entry: Entry): number[] {
	const xfrm = entry.xfrm

	if (entry.slideSpace) return [...IDENTITY]
	if (xfrm.rot === 0) return [1, 0, 0, 1, xfrm.x / EMU_PER_PX, xfrm.y / EMU_PER_PX]

	return boxMatrix(xfrm.x / EMU_PER_PX, xfrm.y / EMU_PER_PX, xfrm.cx / EMU_PER_PX, xfrm.cy / EMU_PER_PX, xfrm.rot / 60000, false, false)
}

// A layer's identity: the shape it draws, named in the node that owns it (a layout's or master's shape drawn on a
// slide names that layout or master, so it never shares a ref with a slide shape of the same id). `child` names the
// group child (of entry.shape) the layer draws, with its own role and alt text (the group's actions and lock hold for
// its children unless the child has its own).
function layerBase(
	entry: Entry,
	id: number,
	child?: ShapeNode
): Pick<SlideLayer, "shape" | "role" | "alt" | "actions" | "lock" | "media" | "holds"> {
	const shape = child ?? entry.shape
	// A group drawn in parts: each part's layer carries what the whole group holds, so a group shown only through its
	// children's layers still says what flipping it would mirror.
	const holds = entryHeldRoles(entry)
	const alt = shape.alt?.decorative === true ? undefined : (shape.alt?.descr ?? shape.alt?.title)
	const actions = shape.actions ?? entry.shape.actions
	const lock = shape.lock ?? entry.shape.lock

	return {
		shape: { slide: entry.owner.ref, id },
		role: child === undefined ? entry.role : roleOf(entry.owner, child),
		...(alt === undefined || alt === "" ? {} : { alt }),
		...(actions === undefined ? {} : { actions }),
		...(lock === undefined ? {} : { lock }),
		...(shape.media === undefined ? {} : { media: mediaInfo(shape.media, entry.owner, shape.id) }),
		...(holds.length === 0 ? {} : { holds })
	}
}

const FRAME_ROLES: ReadonlySet<LayerRole> = new Set(["table", "chart", "smartart", "ole", "media"])

// The roles of the graphic frames and media among a group's members, however deep (drawn on the group's layer or on
// their own): what flipping the group would mirror. Empty for a shape that is no group.
// Once per render's entry (a group drawn in parts asks for every part's layer; the model may change between renders).
const heldRolesOf = new WeakMap<Entry, LayerRole[]>()

function entryHeldRoles(entry: Entry): LayerRole[] {
	let roles = heldRolesOf.get(entry)

	if (roles === undefined) {
		roles = heldRoles(entry.shape)
		heldRolesOf.set(entry, roles)
	}

	return roles
}

function heldRoles(shape: ShapeNode): LayerRole[] {
	if (shape.children === undefined) return []

	const out = new Set<LayerRole>()
	const stack = [...shape.children]

	for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
		if (member.media !== undefined) out.add("media")
		if (member.kind === "frame") {
			const kind = member.frame?.kind

			if (kind !== undefined && FRAME_ROLES.has(kind as LayerRole)) out.add(kind as LayerRole)
		}

		for (const inner of member.children ?? []) stack.push(inner)
	}

	return [...out]
}

// What a medium's layer plays, with its playback options from the slide's timing.
function mediaInfo(media: MediaRef, owner: SlideNode, id: number): SlideMediaInfo {
	const playback = mediaPlayback(owner.timing, id)
	const triggered = [...new Set(bookmarkTriggers(owner.timing).flatMap(trigger => (trigger.shape === id ? [trigger.bookmark] : [])))]

	return {
		kind: media.kind,
		...(media.part === undefined ? {} : { part: media.part }),
		...(media.external === undefined ? {} : { external: media.external }),
		contentType: media.contentType,
		...(media.size === undefined ? {} : { size: media.size }),
		...(Object.keys(playback).length === 0 ? {} : { playback }),
		...(media.timing === undefined ? {} : { timing: media.timing }),
		...(triggered.length === 0 ? {} : { triggered })
	}
}

// The descendant of a group with this id.
function childShape(shapes: readonly ShapeNode[] | undefined, id: number): ShapeNode | undefined {
	for (const shape of shapes ?? []) {
		if (shape.id === id) return shape

		const found = childShape(shape.children, id)

		if (found !== undefined) return found
	}

	return undefined
}

function layoutText(
	deck: Deck,
	slide: SlideNode,
	services: RenderServices,
	theme: DrawingTheme,
	target: TextTarget,
	box: { readonly width: number; readonly height: number }
): TextPage | undefined {
	return services.layoutText?.(textRequest(deck, slide, theme, target, box))?.page
}

// An empty slide placeholder's prompt laid out as its own body would be (its chain, box and bodyPr).
function promptPage(
	deck: Deck,
	slide: SlideNode,
	services: RenderServices,
	theme: DrawingTheme,
	target: TextTarget,
	box: { readonly width: number; readonly height: number },
	prompts: PlaceholderPrompts | undefined
): TextPage | undefined {
	if (prompts === undefined || target.owner !== slide || services.layoutText === undefined) return undefined

	const body = promptBody(target.shape, target.chain, prompts)

	if (body === undefined) return undefined

	return services.layoutText({ ...textRequest(deck, slide, theme, { ...target, body }, box), prompt: true })?.page
}

function textRequest(
	deck: Deck,
	slide: SlideNode,
	theme: DrawingTheme,
	target: TextTarget,
	box: { readonly width: number; readonly height: number }
): TextLayoutRequest {
	return {
		deck,
		slide,
		owner: target.owner,
		shape: target.shape,
		chain: target.chain,
		body: target.body,
		bodyPr: target.bodyPr,
		width: box.width,
		height: box.height,
		theme
	}
}

async function renderEntry(
	deck: Deck,
	slide: SlideNode,
	entry: Entry,
	scratch: Scratch,
	tree: number,
	scratchReader: DrawingReader,
	theme: DrawingTheme,
	services: RenderServices,
	slicing: Slicing,
	report: RenderReport,
	layers: SlideLayer[],
	prompts: PlaceholderPrompts | undefined
): Promise<void> {
	const xfrm = entry.xfrm
	const w = xfrm.cx / EMU_PER_PX
	const h = xfrm.cy / EMU_PER_PX
	const matrix = entryMatrix(entry)
	const drawn = new DrawingList()
	const base = layerBase(entry, entry.shape.id)
	const images = (id: string): ReturnType<ScratchWriter["image"]> => scratch.writer.image(id)

	if (entry.shape.kind === "frame") {
		const frame = entry.shape.frame

		const list = drawn

		list.width = w
		list.height = h

		if (frame?.kind === "table") {
			await renderTableLayer(deck, slide, entry, frame.table, list, theme, services, matrix, base, slicing, report, layers)

			return
		}

		const context: ShapeContext = { list, theme, images, effects: true }
		// SmartArt text is laid out by the text adapter, as slide shapes' is.
		const texts = frame?.kind === "smartart" ? new SmartArtTexts(deck, entry.owner, entry.shape, services) : undefined
		const drew =
			frame !== undefined &&
			(await drawFrame(
				frame,
				base.shape,
				entry.shape.src?.part,
				context,
				services,
				undefined,
				xfrm.cx,
				xfrm.cy,
				slicing,
				report,
				texts
			))

		if (!drew) report.refuse(`frame:${frame?.kind ?? "missing"}`)

		// OLE previews and media posters that are metafiles, tiled fills.
		const finished = (await finishPictures(list, services, report)).list

		if (texts === undefined || texts.texts.length === 0) {
			layers.push({ ...base, drawing: drawingData(finished), matrix })

			return
		}

		await layersOf({
			deck,
			slide,
			entry,
			list: finished,
			texts: story => smartArtTarget(texts, story),
			overlays: [],
			matrix,
			base,
			effects: undefined,
			theme,
			services,
			report,
			layers
		})

		return
	}

	const nested: Promise<boolean>[] = []
	const overlays: Overlay[] = []
	const context: ShapeContext = {
		list: drawn,
		theme,
		images,
		effects: true,
		body: txBody => {
			const mark = scratchReader.attr(txBody, TEXT_MARK)

			return mark === undefined ? undefined : Number(mark)
		},
		frame: (frameReader, node, target, frameMatrix, width, height) => {
			const index = Number(frameReader.attr(node, FRAME_MARK) ?? "-1")
			const child = scratch.frames[index]
			const frame = child?.frame

			if (child === undefined || frame === undefined) {
				report.refuse("frameInGroup:missing")

				return false
			}

			// Tables (their cell texts) and SmartArt (a shape tree of its own frame) become layers of their own over the
			// group's drawing, placed through the group.
			if (frame.kind === "table" || frame.kind === "smartart") {
				overlays.push({ shape: child, matrix: frameMatrix, width, height, at: drawn.itemCount })

				return true
			}

			nested.push(
				drawFrame(
					frame,
					base.shape,
					entry.shape.src?.part,
					{ ...context, list: target },
					services,
					frameMatrix,
					width,
					height,
					slicing,
					report
				)
			)

			return true
		}
	}
	const conversion = convertShapeTree(context, scratch.document, tree, xfrm.cx, xfrm.cy)

	await Promise.all(nested)

	// EMF/WMF pictures replaced by what they draw (the items move, so overlay positions are carried over), tiles placed.
	const expanded = await finishPictures(drawn, services, report)
	const list = expanded.list

	if (conversion.unsupported > 0) report.refuse("element", conversion.unsupported)
	if (conversion.childEffects > 0) report.approximate("group:childEffects", conversion.childEffects)

	// 3D is never copied into the resolved element: counted from the nearest level that has it.
	for (const name of FLAT) {
		const level = entry.levels.find(
			candidate => candidate.source !== undefined && candidate.source.reader.child(candidate.source.properties, D.A, name) >= 0
		)

		if (level !== undefined) report.approximate(name)
	}

	const element = scratch.document.firstChildElement(tree)
	// A shape that draws no fill or line: PowerPoint draws its effects (its first outer shadow too, which no item
	// carries) on its text. Only a p:sp is judged: a picture always draws, and a group's items are its children's.
	const sp = element >= 0 && scratch.document.localName(element) === "sp"
	let carried = !sp
	let painted = !sp

	for (let item = 0; sp && item < list.itemCount && !carried; item++) {
		if (list.itemInt(item, ItemInt.SHADOW) >= 0) carried = true
		if (list.kind(item) !== ItemKind.TEXT) painted = true
	}

	const effects = element < 0 ? undefined : layerEffects(context, scratchReader, element, report, carried)
	await layersOf({
		deck,
		slide,
		entry,
		list,
		texts: story => scratch.texts[story],
		overlays: overlays.map(overlay => ({ at: expanded.starts?.[overlay.at] ?? overlay.at, overlay })),
		matrix,
		base,
		effects,
		effectsOnText: !painted,
		theme,
		services,
		report,
		layers,
		prompts,
		overlay: overlay => renderOverlay(deck, slide, entry, overlay, matrix, theme, services, images, slicing, report, layers)
	})
}

interface Overlay {
	readonly shape: ShapeNode
	readonly matrix: readonly number[]
	readonly width: number
	readonly height: number
	// The item the overlay stacks before (the drawing up to there is under it).
	readonly at: number
}

// A drawing as layers, cut at every story text (laid out by the text adapter) and every overlay, so each paints in its
// shape's own z position: a child's text right after that child's drawing, under the next sibling (spTree order).
async function layersOf(input: {
	readonly deck: Deck
	readonly slide: SlideNode
	readonly entry: Entry
	readonly list: DrawingList
	readonly texts: (story: number) => TextTarget | undefined
	readonly overlays: readonly { readonly at: number; readonly overlay: Overlay }[]
	readonly matrix: number[]
	readonly base: ReturnType<typeof layerBase>
	readonly effects: SlideLayer["effects"]
	readonly effectsOnText?: boolean
	readonly theme: DrawingTheme
	readonly services: RenderServices
	readonly report: RenderReport
	readonly layers: SlideLayer[]
	// The slide's empty placeholders get their prompt laid out (the editor's view).
	readonly prompts?: PlaceholderPrompts | undefined
	readonly overlay?: (overlay: Overlay) => Promise<void>
}): Promise<void> {
	const { deck, slide, entry, list, matrix, base, effects, theme, services, report, layers } = input
	const drawing = drawingData(list)
	const cuts: { readonly at: number; readonly text?: number; readonly overlay?: Overlay }[] = []

	for (let item = 0; item < list.itemCount; item++) {
		if (list.kind(item) !== ItemKind.TEXT) continue

		const text = list.texts[list.itemInt(item, ItemInt.REF)]

		if (text?.kind === "story" && input.texts(text.story) !== undefined) cuts.push({ at: item + 1, text: item })
	}

	for (const overlay of input.overlays) cuts.push(overlay)
	cuts.sort((a, b) => a.at - b.at || (a.overlay === undefined ? -1 : 1))

	let start = 0
	let first = true
	const segment = (
		end: number,
		id: number
	): Pick<SlideLayer, "shape" | "role" | "alt" | "actions" | "lock" | "media"> & Pick<SlideLayer, "drawing"> => {
		// The entry's own base (its effects, alt, actions) only for its own layer: a group child's text layer is the child's.
		const piece =
			id === entry.shape.id ? (first ? base : layerBase(entry, id)) : layerBase(entry, id, childShape(entry.shape.children, id))
		const part = start === 0 && end === list.itemCount ? drawing : drawingSlice(drawing, start, end)

		start = end

		return { ...piece, drawing: part }
	}
	const push = (layer: SlideLayer): void => {
		layers.push(
			first && effects !== undefined
				? { ...layer, effects, ...(input.effectsOnText === true ? { effectsOnText: true as const } : {}) }
				: layer
		)
		first = false
	}

	for (const cut of cuts) {
		if (cut.text !== undefined) {
			const item = cut.text
			const story = list.texts[list.itemInt(item, ItemInt.REF)]
			const target = story?.kind === "story" ? input.texts(story.story) : undefined

			if (target === undefined) continue

			const itemMatrix = [ItemFloat.A, ItemFloat.B, ItemFloat.C, ItemFloat.D, ItemFloat.E, ItemFloat.F].map(field =>
				list.itemFloat(item, field)
			)
			const box = textBox(
				itemMatrix,
				list.itemFloat(item, ItemFloat.X),
				list.itemFloat(item, ItemFloat.Y),
				list.itemFloat(item, ItemFloat.WIDTH),
				list.itemFloat(item, ItemFloat.HEIGHT),
				target.bodyPr
			)
			const page = target.empty === true ? undefined : layoutText(deck, slide, services, theme, target, box)
			const warp = page === undefined ? undefined : warpOf(services, target, box, page, report)

			// The text adapter still hears of an empty body (the editor's text context is read from it); nothing paints.
			if (target.empty === true) services.layoutText?.(textRequest(deck, slide, theme, target, box))

			const prompt = target.empty === true ? promptPage(deck, slide, services, theme, target, box, input.prompts) : undefined

			push({
				...segment(cut.at, target.shape.id),
				...(page === undefined ? {} : { text: page }),
				...(prompt === undefined ? {} : { prompt }),
				matrix,
				textMatrix: warp === undefined ? multiply(matrix, box.matrix) : multiply(multiply(matrix, box.matrix), warp)
			})

			continue
		}

		const overlay = cut.overlay

		if (overlay === undefined || input.overlay === undefined) continue
		if (cut.at > start) push({ ...segment(cut.at, entry.shape.id), matrix })

		await input.overlay(overlay)
		first = false
	}

	if (start < list.itemCount || first) push({ ...segment(list.itemCount, entry.shape.id), matrix })
}

// The affine fit of the WordArt warp the shape or its nearest placeholder writes (warp.ts), in text page px; undefined
// for none. Sideways text keeps its turn and is not warped.
function warpOf(
	services: RenderServices,
	target: TextTarget,
	box: { readonly width: number; readonly height: number },
	page: TextPage,
	report: RenderReport
): readonly number[] | undefined {
	for (const shape of [target.shape, ...target.chain.map(level => level.shape)]) {
		const source = levelSource(services, shape)
		const txBody = source === undefined ? -1 : source.reader.child(source.element, D.P, "txBody")
		const warp = txBody < 0 || source === undefined ? undefined : readTextWarp(source.reader, txBody)

		if (warp === undefined) continue
		if (turnOf(target.bodyPr.vertical) !== 0) {
			report.approximate("prstTxWarp:vertical")

			return undefined
		}

		const fit = fitTextWarp(warp, page.page, page.styles, box.width, box.height)

		if (fit === undefined) report.approximate(`prstTxWarp:${warp.preset}`)
		else if (fit.approximate) report.approximate(`prstTxWarp:${warp.preset}`)

		return fit?.matrix
	}

	return undefined
}

function smartArtTarget(texts: SmartArtTexts, story: number): TextTarget | undefined {
	const text = texts.texts[story]

	return text === undefined ? undefined : { ...text, chain: [] }
}

// A table or SmartArt frame inside a group, as layers of its own placed through the group.
async function renderOverlay(
	deck: Deck,
	slide: SlideNode,
	entry: Entry,
	overlay: { readonly shape: ShapeNode; readonly matrix: readonly number[]; readonly width: number; readonly height: number },
	matrix: readonly number[],
	theme: DrawingTheme,
	services: RenderServices,
	images: (id: string) => ReturnType<ScratchWriter["image"]>,
	slicing: Slicing,
	report: RenderReport,
	layers: SlideLayer[]
): Promise<void> {
	const frame = overlay.shape.frame
	// Drawn at the frame's own size, scaled into the box the group's child space gives it.
	const cx = overlay.shape.xfrm?.cx ?? overlay.width
	const cy = overlay.shape.xfrm?.cy ?? overlay.height
	const placed = multiply(multiply(matrix, overlay.matrix), [
		cx > 0 ? overlay.width / cx : 1,
		0,
		0,
		cy > 0 ? overlay.height / cy : 1,
		0,
		0
	])
	const own = new DrawingList()
	const overlayBase = layerBase({ ...entry, role: frame?.kind === "table" ? "table" : "smartart" }, overlay.shape.id)

	own.width = cx / EMU_PER_PX
	own.height = cy / EMU_PER_PX

	if (frame?.kind === "table") {
		await renderTableLayer(
			deck,
			slide,
			{ ...entry, shape: overlay.shape },
			frame.table,
			own,
			theme,
			services,
			placed,
			overlayBase,
			slicing,
			report,
			layers
		)
	} else if (frame !== undefined) {
		const texts = frame.kind === "smartart" ? new SmartArtTexts(deck, entry.owner, overlay.shape, services) : undefined
		const drew = await drawFrame(
			frame,
			overlayBase.shape,
			entry.shape.src?.part,
			{ list: own, theme, images, effects: true },
			services,
			undefined,
			cx,
			cy,
			slicing,
			report,
			texts
		)

		if (!drew) return

		const finished = (await finishPictures(own, services, report)).list

		if (texts === undefined || texts.texts.length === 0) {
			layers.push({ ...overlayBase, drawing: drawingData(finished), matrix: placed })

			return
		}

		await layersOf({
			deck,
			slide,
			entry: { ...entry, role: "smartart", shape: overlay.shape },
			list: finished,
			texts: story => smartArtTarget(texts, story),
			overlays: [],
			matrix: placed,
			base: overlayBase,
			effects: undefined,
			theme,
			services,
			report,
			layers
		})
	}
}

// Items [start, end) of a drawing: its own item arrays, the shared path, paint and image tables.
function drawingSlice(data: DrawingData, start: number, end: number): DrawingData {
	return {
		...data,
		itemCount: end - start,
		itemFloats: data.itemFloats.slice(start * ITEM_FLOATS, end * ITEM_FLOATS),
		itemInts: data.itemInts.slice(start * ITEM_INTS, end * ITEM_INTS),
		...(data.itemClips === undefined ? {} : { itemClips: data.itemClips.slice(start, end) })
	}
}

async function renderTableLayer(
	deck: Deck,
	slide: SlideNode,
	entry: Entry,
	table: TableRenderInput["table"],
	list: DrawingList,
	theme: DrawingTheme,
	services: RenderServices,
	matrix: readonly number[],
	base: ReturnType<typeof layerBase>,
	slicing: Slicing,
	report: RenderReport,
	layers: SlideLayer[]
): Promise<void> {
	const clock = sliceClock(slicing)
	const part = table.src?.format === "pptx" ? table.src.part : entry.shape.src?.part
	const stylesPart = tableStylesPart(services)
	const stylesDocument = stylesPart === undefined ? undefined : services.xml(stylesPart)
	const context = { list, theme, images: () => undefined, effects: false }
	const request = (
		cellText: TextBody,
		width: number,
		height: number,
		cell: { row: number; column: number; style: TableTextStyle | undefined },
		bodyPr: TextBodyProps = CELL_BODY
	) =>
		services.layoutText?.({
			deck,
			slide,
			owner: entry.owner,
			shape: entry.shape,
			chain: [],
			body: cellText,
			bodyPr: { ...bodyPr },
			width,
			height,
			theme,
			cell
		})
	const heights = new Map<string, number>()
	// A table is cut into steps (one per cell), so a large or hostile one never holds the thread past a slice.
	const steps = renderTableSteps({
		table,
		context,
		services,
		part,
		tableStyles: stylesDocument === undefined || stylesPart === undefined ? undefined : { document: stylesDocument, part: stylesPart },
		// An empty cell still holds its paragraph mark's line: a row never shrinks below it (as PowerPoint and LibreOffice
		// lay a table out).
		// A turned cell's lines run down (or up) the cell: wrapped at its row's height, they grow the row by the longest
		// (unwrapped where the row stores no height).
		textHeight: (cell, row, column, width, style, vert, length) => {
			const turned = turnedCellBody(vert)

			if (turned !== undefined) {
				const measured = request(cell.text, length, 0, { row, column, style }, length > 0 ? turned : { ...turned, wrap: false })

				return measured === undefined ? 0 : longestLine(measured.page)
			}

			const result = request(cell.text, width, 0, { row, column, style })
			const height = result?.height ?? 0

			heights.set(`${String(row)}:${String(column)}`, height)

			return height
		}
	})
	const rendered = await runSliced(steps, clock)

	if (rendered.refused !== undefined) report.refuse("table:tooLarge")

	const areas = new Int32Array(rendered.cells.length * 4)
	const textBoxes = new Float64Array(rendered.cells.length * 4)

	rendered.cells.forEach((cell, k) => {
		areas.set([cell.row, cell.column, cell.rowSpan, cell.columnSpan], k * 4)
		textBoxes.set(
			[
				cell.x + cell.marL,
				cell.y + cell.marT,
				Math.max(0, cell.width - cell.marL - cell.marR),
				Math.max(0, cell.height - cell.marT - cell.marB)
			],
			k * 4
		)
	})
	layers.push({
		...base,
		drawing: drawingData(list),
		matrix,
		table: {
			columnEdges: rendered.columnEdges,
			rowEdges: rendered.rowEdges,
			areas,
			textBoxes,
			...(table.styleId === undefined ? {} : { styleId: table.styleId }),
			flags: { ...table.flags }
		}
	})

	for (const cell of rendered.cells) {
		if (clock.due) await clock.pause()

		const turned = turnedCellBody(cell.vert)
		const hasText = cellHasText(cell.cell.text)

		if (turned !== undefined) {
			// Laid out in the turned inner box (textBox swaps its sides), anchored across the cell. An empty one still gets
			// its box, so the editor types into it turned. The rows grew to its longest line, so it wraps where it measured.
			const insets = { left: cell.marL, top: cell.marT, right: cell.marR, bottom: cell.marB }
			const box = textBox(IDENTITY, cell.x, cell.y, cell.width, cell.height, { ...turned, insets })
			const where = { row: cell.row, column: cell.column, style: cell.textStyle }
			const result = request(cell.cell.text, box.width, box.height, where, turned)

			if (result === undefined) continue

			const spare = box.height - result.height
			const offset = Math.max(0, cell.anchor === "ctr" ? spare / 2 : cell.anchor === "b" ? spare : 0)

			layers.push({
				...base,
				drawing: emptyDrawing(0, 0),
				...(hasText ? { text: result.page } : {}),
				matrix,
				textMatrix: multiply(matrix, multiply(box.matrix, [1, 0, 0, 1, 0, offset])),
				cell: [cell.row, cell.column]
			})

			continue
		}

		if (!hasText) continue
		// Stacked WordArt (wordArtVert, wordArtVertRtl) is drawn horizontally.
		if (cell.vert !== undefined && cell.vert !== "horz") report.approximate("tableCell:vert")

		const width = Math.max(0, cell.width - cell.marL - cell.marR)
		const available = Math.max(0, cell.height - cell.marT - cell.marB)
		const result = request(cell.cell.text, width, available, { row: cell.row, column: cell.column, style: cell.textStyle })

		if (result === undefined) continue

		const used = heights.get(`${String(cell.row)}:${String(cell.column)}`) ?? result.height
		const offset = cell.anchor === "ctr" ? (available - used) / 2 : cell.anchor === "b" ? available - used : 0

		layers.push({
			...base,
			drawing: emptyDrawing(0, 0),
			text: result.page,
			matrix,
			textMatrix: multiply(matrix, [1, 0, 0, 1, cell.x + cell.marL, cell.y + cell.marT + Math.max(0, offset)]),
			cell: [cell.row, cell.column]
		})
	}
}

// Cell text is laid out at the cell's box with no insets of its own (the margins are the cell's).
const CELL_BODY: TextBodyProps = {
	insets: { left: 0, top: 0, right: 0, bottom: 0 },
	anchor: "t",
	anchorCenter: false,
	vertical: "horz",
	wrap: true,
	rotation: 0,
	upright: false,
	columns: 1,
	columnSpacing: 0,
	autofit: "none",
	fontScale: 1,
	lineSpacingReduction: 0
}

// A cell body turned by its tcPr@vert (§21.1.3.17; the values turnOf turns); undefined for horizontal and stacked text.
function turnedCellBody(vert: string | undefined): TextBodyProps | undefined {
	switch (vert) {
		case "vert":
		case "vert270":
		case "eaVert":
		case "mongolianVert":
			return { ...CELL_BODY, vertical: vert }
		default:
			return undefined
	}
}

// The longest line of a laid-out page along its lines (px).
function longestLine(page: TextPage): number {
	const lines = page.page.lineFloats
	let longest = 0

	for (let line = 0; line < page.page.lineCount; line++) {
		const x = lines[line * LINE_FLOATS + 3] ?? 0
		const width = lines[line * LINE_FLOATS + 4] ?? 0

		longest = Math.max(longest, width, x + width)
	}

	return longest
}

function cellHasText(body: TextBody): boolean {
	return body.paragraphs.some(paragraph => paragraph.runs.some(run => run.kind !== "br" && run.text !== ""))
}

// The tableStyles part (the presentation's relationship of that type), else its usual name.
function tableStylesPart(services: RenderServices): string | undefined {
	const part = services.tableStylesPart ?? "/ppt/tableStyles.xml"

	return services.xml(part) === undefined ? undefined : part
}
