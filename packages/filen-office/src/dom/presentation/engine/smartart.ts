import { DrawingList, IDENTITY } from "../../../core/drawingml/displayList"
import { D, EMU_PER_PX, drawingReader, type DrawingReader } from "../../../core/drawingml/reader"
import { convertSmartArt } from "../../../core/drawingml/smartart"
import type { DeckChanges } from "../../../core/presentation/edit/apply"
import type { SmartArtDefRef } from "../../../core/presentation/edit/ops"
import {
	PresentationError,
	type Deck,
	type FrameRef,
	type ShapeNode,
	type ShapeRef,
	type SlideNode
} from "../../../core/presentation/model"
import type { SlideRender } from "../../../core/presentation/output"
import type { RenderServices, SmartArtRenderer } from "../../../core/presentation/render/services"
import { drawingData } from "../../../core/presentation/render/slide"
import { ThemeCache } from "../../../core/presentation/render/theme"
import { themeOf } from "../../../core/presentation/theme"
import { sliceClock, type Slicing } from "../../../core/slicing"
import { parseDataModel, pointText, SmartArtError, type DataModel, type DataPoint } from "../../../core/smartart/data"
import { diagramInfo, drawingKey, rememberDrawing, type SmartArtInfo } from "../../../core/smartart/edit"
import { emitDiagram, type EmittedDiagram } from "../../../core/smartart/emit"
import { smartArtColorsDef, smartArtLayoutDef, smartArtStyleDef } from "../../../core/smartart/gallery/defs"
import { smartArtLayout } from "../../../core/smartart/gallery/index"
import { layoutDiagram, type TextMeasurer } from "../../../core/smartart/interp"
import { parseLayoutDef } from "../../../core/smartart/layoutDef"
import { escapeText } from "../../../core/xml/entities"
import { parseXml, type XmlDocument } from "../../../core/xml/index"
import type { EngineSession, SmartArtCapability } from "../engine"
import { presentationRealm } from "../services"
import { rasterizeSlide } from "../thumbs"
import { pptxParts } from "./open/pptx"

// The SmartArt engine in the presentation worker: a diagram without a usable drawing cache is laid out from its
// data and its definitions (core/smartart) and drawn as the drawing PowerPoint would cache (emit.ts); the editor
// relays a diagram out through the same path, and the gallery and the switch-layout menu get previews of a layout
// laid out over sample text. The renderer's host (the view) registers what the engine reads through
// (smartArtRenderer): the parts it has parsed and a measurer over the slide text adapter. Relayouts are kept per
// session by slide revision, frame size and parts (MAX_CACHED, least recently used out).

export interface SmartArtHost {
	readonly services: RenderServices
	// A measurer over the slide text adapter with `slide`'s theme fonts, asking for the faces `texts` need; absent,
	// text is measured by average advances.
	measurer?(slide: SlideNode, texts: readonly (string | DataPoint)[]): TextMeasurer
	// Changes when faces the measurer reads have been loaded since (a relayout measured without them is redone).
	fontGeneration?(): number
}

const MAX_CACHED = 64
// The preview's diagram box (4 : 3, as the gallery shows it), EMU.
const PREVIEW_BOX = { w: 4_572_000, h: 3_429_000 }
const PREVIEW_MIN_WIDTH = 16
const PREVIEW_MAX_WIDTH = 1024
const MAX_SAMPLE = 64
const MAX_GROUP_DEPTH = 128

const hosts = new WeakMap<EngineSession, SmartArtHost>()
const caches = new WeakMap<EngineSession, Map<string, EmittedDiagram>>()

// Average advances and line pitch of a sans face: what sizes text when no text adapter is there.
export const AVERAGE_MEASURER: TextMeasurer = {
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

function refusal(error: unknown): PresentationError {
	if (error instanceof PresentationError) return error
	if (error instanceof SmartArtError) return new PresentationError(error.reason, error.message)

	return new PresentationError("malformed", error instanceof Error ? error.message : "smartart")
}

// A child element (dgm:t, dgm:spPr) of every point, by modelId, for the drawing's text bodies and the user's own
// shape properties.
function pointIndex(document: XmlDocument, local: string): (point: DataPoint) => { reader: DrawingReader; node: number } | undefined {
	const reader = drawingReader(document)
	const index = new Map<string, number>()
	const list = reader.child(document.documentElement(), D.Dgm, "ptLst")

	for (const pt of reader.children(list, D.Dgm, "pt")) {
		const id = reader.attr(pt, "modelId")
		const t = reader.child(pt, D.Dgm, local)

		if (id !== undefined && t >= 0 && !index.has(id)) index.set(id, t)
	}

	return point => {
		const node = index.get(point.id)

		return node === undefined ? undefined : { reader, node }
	}
}

export interface DiagramSources {
	readonly data: XmlDocument
	readonly layout: XmlDocument
	readonly style: XmlDocument | undefined
	readonly colors: XmlDocument | undefined
}

// Lays a diagram out in a w × h EMU frame and emits its drawing; refuses (PresentationError) past the SmartArt
// budgets or on malformed parts.
export function relayoutDiagram(
	sources: DiagramSources,
	box: { readonly w: number; readonly h: number },
	measurerFor: (model: DataModel) => TextMeasurer
): EmittedDiagram {
	try {
		const model = parseDataModel(sources.data)
		const def = parseLayoutDef(sources.layout)
		const layout = layoutDiagram(model, def, sources.style, sources.colors, { x: 0, y: 0, w: box.w, h: box.h }, measurerFor(model))

		return emitDiagram(layout, { text: pointIndex(sources.data, "t"), shapeProps: pointIndex(sources.data, "spPr") })
	} catch (error) {
		throw refusal(error)
	}
}

function findShape(shapes: readonly ShapeNode[], id: number, depth: number): ShapeNode | undefined {
	if (depth > MAX_GROUP_DEPTH) return undefined

	for (const shape of shapes) {
		if (shape.id === id) return shape

		const inner = shape.children === undefined ? undefined : findShape(shape.children, id, depth + 1)

		if (inner !== undefined) return inner
	}

	return undefined
}

function frameOf(deck: Deck, target: ShapeRef): { shape: ShapeNode; frame: Extract<FrameRef, { kind: "smartart" }> } {
	const slide = deck.nodes.get(target.slide)
	const shape = slide === undefined ? undefined : findShape(slide.shapes, target.id, 0)
	const frame = shape?.frame

	if (shape === undefined || frame?.kind !== "smartart") throw new PresentationError("notFound", "smartart frame")

	return { shape, frame }
}

// The prompt boxes of each diagram as last laid out (slide:id → the data part it was laid out from and its boxes).
const prompts = new WeakMap<EngineSession, Map<string, { readonly data: string; readonly boxes: EmittedDiagram["prompts"] }>>()

function promptsOf(session: EngineSession): Map<string, { readonly data: string; readonly boxes: EmittedDiagram["prompts"] }> {
	let held = prompts.get(session)

	if (held === undefined) {
		const created = new Map<string, { readonly data: string; readonly boxes: EmittedDiagram["prompts"] }>()

		prompts.set(session, created)
		session.onClose(() => created.clear())
		held = created
	}

	return held
}

function sessionCache(session: EngineSession): Map<string, EmittedDiagram> {
	let cache = caches.get(session)

	if (cache === undefined) {
		const created = new Map<string, EmittedDiagram>()

		caches.set(session, created)
		session.onClose(() => created.clear())
		cache = created
	}

	return cache
}

// The points that hold text: the measurer asks for the faces their runs use (bold, italic, their own typeface).
function texts(model: DataModel): DataPoint[] {
	const out: DataPoint[] = []

	for (const point of model.points.values()) if (pointText(point) !== "") out.push(point)

	return out
}

async function relayoutTarget(
	session: EngineSession,
	host: SmartArtHost,
	target: ShapeRef,
	frame: Extract<FrameRef, { kind: "smartart" }>,
	box: { readonly w: number; readonly h: number },
	slicing: Slicing
): Promise<EmittedDiagram> {
	const slide = session.deck.nodes.get(target.slide)

	if (slide === undefined) throw new PresentationError("notFound", "slide")

	// The theme the measurer reads fonts through (slideFonts): a theme edit or swap relays the diagram out, however the
	// slide's own revision moves.
	const theme = themeOf(session.deck.nodes, slide)
	const key = [
		target.slide,
		target.id,
		slide.revision,
		theme?.part ?? "",
		theme?.revision ?? 0,
		host.fontGeneration?.() ?? 0,
		Math.round(box.w),
		Math.round(box.h),
		frame.data,
		frame.layout,
		frame.style,
		frame.colors
	].join("\u0000")
	const cache = sessionCache(session)
	const known = cache.get(key)
	// The drawing the writer saves for an edited diagram is the one laid out here (core/smartart/edit.ts).
	const remember = (emitted: EmittedDiagram): void => {
		const data = host.services.xml(frame.data)

		promptsOf(session).set(`${String(target.slide)}:${String(target.id)}`, { data: frame.data, boxes: emitted.prompts })

		if (data !== undefined) rememberDrawing(data, drawingKey(frame.layout, frame.style, frame.colors, box.w, box.h), emitted.drawingXml)
	}

	if (known !== undefined) {
		cache.delete(key)
		cache.set(key, known)
		remember(known)

		return known
	}

	const clock = sliceClock(slicing)

	if (clock.due) await clock.pause()

	const services = host.services
	const data = services.xml(frame.data)
	const layout = services.xml(frame.layout)

	if (data === undefined || layout === undefined) throw new PresentationError("notFound", "smartart parts")

	const emitted = relayoutDiagram({ data, layout, style: services.xml(frame.style), colors: services.xml(frame.colors) }, box, model =>
		host.measurer === undefined ? AVERAGE_MEASURER : host.measurer(slide, texts(model))
	)

	cache.set(key, emitted)
	remember(emitted)

	if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string)

	return emitted
}

// The renderer's SmartArt engine for a session, over its host; registers the host for the session's relayouts and
// previews.
export function smartArtRenderer(session: EngineSession, host: SmartArtHost): SmartArtRenderer {
	hosts.set(session, host)

	return {
		async relayout(target, frame, slicing) {
			const xfrm = findShape(session.deck.nodes.get(target.slide)?.shapes ?? [], target.id, 0)?.xfrm

			if (xfrm === undefined || !(xfrm.cx > 0 && xfrm.cy > 0)) return undefined

			try {
				return await relayoutTarget(session, host, target, frame, { w: xfrm.cx, h: xfrm.cy }, slicing)
			} catch (error) {
				// The renderer reports the diagram as undrawn; aborts go on up.
				if (error instanceof PresentationError && error.reason === "aborted") throw error

				return undefined
			}
		}
	}
}

function hostOf(session: EngineSession): SmartArtHost {
	const host = hosts.get(session)

	if (host === undefined) throw new PresentationError("notFound", "smartart host: no slide has been rendered")

	return host
}

type DefinitionKind = "layout" | "style" | "colors"

const ROOTS: Readonly<Record<DefinitionKind, string>> = { layout: "layoutDef", style: "styleDef", colors: "colorsDef" }

function partOf(frame: Extract<FrameRef, { kind: "smartart" }>, kind: DefinitionKind): string {
	return kind === "layout" ? frame.layout : kind === "style" ? frame.style : frame.colors
}

function* frames(shapes: readonly ShapeNode[], depth: number): Generator<Extract<FrameRef, { kind: "smartart" }>> {
	if (depth > MAX_GROUP_DEPTH) return

	for (const shape of shapes) {
		if (shape.frame?.kind === "smartart") yield shape.frame
		if (shape.children !== undefined) yield* frames(shape.children, depth + 1)
	}
}

// A definition by uniqueId: our gallery's, or one a diagram of the deck embeds (the file's own definitions serve
// that file only).
function definition(
	session: EngineSession,
	host: SmartArtHost,
	kind: DefinitionKind,
	ref: SmartArtDefRef | undefined
): XmlDocument | undefined {
	if (ref === undefined) return undefined

	if (ref.source === "gallery") {
		const text =
			kind === "layout"
				? smartArtLayoutDef(ref.uniqueId)
				: kind === "style"
					? smartArtStyleDef(ref.uniqueId)
					: smartArtColorsDef(ref.uniqueId)

		return text === undefined ? undefined : parseXml(new TextEncoder().encode(text))
	}

	const seen = new Set<string>()

	for (const node of session.deck.nodes.values()) {
		for (const frame of frames(node.shapes, 0)) {
			const part = partOf(frame, kind)

			if (seen.has(part)) continue

			seen.add(part)

			const document = host.services.xml(part)

			if (document === undefined) continue

			const reader = drawingReader(document)
			const element = document.documentElement()

			if (reader.is(element, D.Dgm, ROOTS[kind]) && reader.attr(element, "uniqueId") === ref.uniqueId) return document
		}
	}

	return undefined
}

// A data model of sample nodes, each at its level under the nearest shallower one before it.
export function sampleData(sample: readonly { readonly level: number; readonly text: string }[]): XmlDocument {
	let points = '<dgm:pt modelId="0" type="doc"><dgm:prSet/><dgm:spPr/></dgm:pt>'
	let cxns = ""
	const parents: string[] = ["0"]
	const order = new Map<string, number>()

	sample.slice(0, MAX_SAMPLE).forEach((item, i) => {
		const id = `n${i}`
		const level = Math.max(1, Math.min(parents.length, Math.floor(item.level) || 1))
		const parent = parents[level - 1] as string
		const ord = order.get(parent) ?? 0

		order.set(parent, ord + 1)
		parents.length = level
		parents.push(id)
		points +=
			`<dgm:pt modelId="${id}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeText(item.text)}</a:t></a:r></a:p></dgm:t></dgm:pt>` +
			`<dgm:pt modelId="p${i}" type="parTrans" cxnId="c${i}"/><dgm:pt modelId="s${i}" type="sibTrans" cxnId="c${i}"/>`
		cxns += `<dgm:cxn modelId="c${i}" srcId="${parent}" destId="${id}" srcOrd="${ord}" destOrd="0" parTransId="p${i}" sibTransId="s${i}"/>`
	})

	return parseXml(
		new TextEncoder().encode(
			`<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst>${points}</dgm:ptLst><dgm:cxnLst>${cxns}</dgm:cxnLst></dgm:dataModel>`
		)
	)
}

const EMPTY_SAMPLE = [1, 1, 1].map(level => ({ level, text: "" }))

const KIND_OF_TYPE: ReadonlyMap<string, DefinitionKind> = new Map([
	["application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml", "layout"],
	["application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml", "style"],
	["application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml", "colors"]
])

// A diagram part read once into the package's documents (an op's prepare reads the same way), or one an op held.
async function diagramPart(session: EngineSession, part: string): Promise<XmlDocument | undefined> {
	const parts = pptxParts(session.deck)

	if (parts === undefined || part === "") return undefined

	const held = parts.document(part)

	if (held !== undefined || part.startsWith("raw:") || !parts.opc.has(part)) return held
	if ((parts.opc.entry(part)?.uncompressedSize ?? 0) > parts.budgets.xmlPartBytes) throw new PresentationError("tooLarge", part)

	const document = await parts.opc.xml(part)

	parts.adopt(part, document)

	return document
}

// Edited diagrams (a frame whose data an op holds) laid out before a save's snapshot, so the writer saves the drawing
// the renderer draws even for a slide never shown since the edit (Replace All). One the renderer has not registered
// for, or that does not lay out, is saved without a drawing: the consumer lays it out.
export async function layoutEditedDiagrams(session: EngineSession, changes: DeckChanges, slicing: Slicing): Promise<void> {
	const host = hosts.get(session)

	if (host === undefined) return

	for (const [part, change] of changes.parts) {
		const node = [...session.deck.nodes.values()].find(each => each.part === part)

		if (node === undefined) continue

		for (const id of change.shapes.keys()) {
			const shape = findShape(node.shapes, id, 0)
			const frame = shape?.frame

			if (frame?.kind !== "smartart" || !frame.data.startsWith("raw:") || shape?.xfrm === undefined) continue
			if (!(shape.xfrm.cx > 0 && shape.xfrm.cy > 0)) continue

			try {
				await relayoutTarget(session, host, { slide: node.ref, id }, frame, { w: shape.xfrm.cx, h: shape.xfrm.cy }, slicing)
			} catch (error) {
				if (error instanceof PresentationError && error.reason === "aborted") throw error
			}
		}
	}
}

// The text pane's outline of a diagram and the definitions the deck's parsed diagrams embed.
// Without a slice clock (a caller outside a call) the layout runs to its end.
const UNSLICED: Slicing = { pause: () => Promise.resolve(), sliceMs: Number.POSITIVE_INFINITY, now: () => 0 }

async function diagramInfoOf(session: EngineSession, target: ShapeRef, slicing: Slicing = UNSLICED): Promise<SmartArtInfo> {
	const { shape, frame } = frameOf(session.deck, target)
	const data = await diagramPart(session, frame.data)

	if (data === undefined) throw new PresentationError("notFound", "smartart data")

	// The deck's own definitions: every layout, style and colours part of the package, and those an op holds.
	const definitions: { kind: DefinitionKind; document: XmlDocument }[] = []
	const parts = pptxParts(session.deck)
	const seen = new Set<string>()
	const named = new Map<string, DefinitionKind>()

	for (const node of session.deck.nodes.values())
		for (const each of frames(node.shapes, 0))
			for (const kind of ["layout", "style", "colors"] as const) named.set(partOf(each, kind), kind)

	for (const entry of parts?.opc.entries() ?? []) {
		const kind = KIND_OF_TYPE.get(parts?.contentTypes.typeOf(entry.name) ?? "")

		if (kind !== undefined) named.set(`/${entry.name}`, kind)
	}

	for (const [part, kind] of named) {
		if (part === "" || seen.has(part)) continue

		seen.add(part)

		const document = await diagramPart(session, part)

		if (document !== undefined) definitions.push({ kind, document })
	}

	try {
		const info = diagramInfo(data, definitions)

		if ("kind" in info) throw new PresentationError(info.reason, info.detail ?? "smartart data")

		let laid = promptsOf(session).get(`${String(target.slide)}:${String(target.id)}`)

		// A diagram drawn from its saved drawing (or laid out from older data): laid out now, for an empty node's prompt.
		const host = hosts.get(session)
		const xfrm = shape.xfrm

		if (
			(laid === undefined || laid.data !== frame.data) &&
			host !== undefined &&
			xfrm !== undefined &&
			xfrm.cx > 0 &&
			xfrm.cy > 0 &&
			info.nodes.some(node => node.text === "")
		) {
			await relayoutTarget(session, host, target, frame, { w: xfrm.cx, h: xfrm.cy }, slicing)
			laid = promptsOf(session).get(`${String(target.slide)}:${String(target.id)}`)
		}

		return laid === undefined || laid.data !== frame.data
			? info
			: { ...info, prompts: laid.boxes.map(box => ({ x: box.x, y: box.y, w: box.w, h: box.h })) }
	} catch (error) {
		throw refusal(error)
	}
}

export const smartartCapability: SmartArtCapability = {
	async relayout(session, target, slicing) {
		const host = hostOf(session)
		const { shape, frame } = frameOf(session.deck, target)
		const xfrm = shape.xfrm

		if (xfrm === undefined || !(xfrm.cx > 0 && xfrm.cy > 0)) throw new PresentationError("malformed", "smartart frame size")

		const emitted = await relayoutTarget(session, host, target, frame, { w: xfrm.cx, h: xfrm.cy }, slicing)

		return { shapes: emitted.shapes, drawingXml: emitted.drawingXml }
	},
	async preview(session, layoutRef, options, slicing) {
		const realm = presentationRealm()

		if (realm === undefined) throw new PresentationError("notImplemented", "smartart previews need a canvas realm")

		const width = Math.round(options.widthPx)

		if (!(width >= PREVIEW_MIN_WIDTH && width <= PREVIEW_MAX_WIDTH)) throw new PresentationError("tooLarge", "smartart preview width")

		const host = hostOf(session)
		const layout = definition(session, host, "layout", layoutRef)

		if (layout === undefined) throw new PresentationError("notFound", "smartart layout")

		const entry = layoutRef.source === "gallery" ? smartArtLayout(layoutRef.uniqueId) : undefined
		const sample = options.sample !== undefined ? options.sample.map(text => ({ level: 1, text })) : (entry?.sample ?? EMPTY_SAMPLE)
		const deck = session.deck
		const ref = deck.slides[0] ?? deck.masters[0]
		const themed = ref === undefined ? undefined : deck.nodes.get(ref)

		if (themed === undefined) throw new PresentationError("notFound", "a slide to take the theme from")

		const clock = sliceClock(slicing)

		if (clock.due) await clock.pause()

		const emitted = relayoutDiagram(
			{
				data: sampleData(sample),
				layout,
				style: definition(session, host, "style", options.style),
				colors: definition(session, host, "colors", options.colors)
			},
			PREVIEW_BOX,
			model => (host.measurer === undefined ? AVERAGE_MEASURER : host.measurer(themed, texts(model)))
		)
		const list = new DrawingList()
		const theme = new ThemeCache(host.services).of(deck, themed)

		list.width = PREVIEW_BOX.w / EMU_PER_PX
		list.height = PREVIEW_BOX.h / EMU_PER_PX

		convertSmartArt(
			{ list, theme, images: () => undefined, effects: true },
			parseXml(new TextEncoder().encode(emitted.drawingXml)),
			PREVIEW_BOX.w,
			PREVIEW_BOX.h
		)

		const background = new DrawingList()

		background.width = list.width
		background.height = list.height

		const render: SlideRender = {
			ref: themed.ref,
			index: 0,
			revision: 0,
			hidden: false,
			background: drawingData(background),
			layers: [{ shape: { slide: themed.ref, id: 0 }, drawing: drawingData(list), matrix: [...IDENTITY], role: "smartart" }],
			notesText: "",
			animated: false
		}
		const raster = await rasterizeSlide(render, {
			canvas: realm.canvas,
			size: { cx: PREVIEW_BOX.w, cy: PREVIEW_BOX.h },
			widthPx: width,
			read: () => Promise.resolve(null)
		})

		if (raster === undefined) throw new PresentationError("tooLarge", "smartart preview canvas")

		return raster.bitmap
	},
	info: (session, target) => diagramInfoOf(session, target),
	smartArtPreview: (context, layout, options) => smartartCapability.preview(context.session, layout, options, context.slicing),
	smartArtInfo: (context, target) => diagramInfoOf(context.session, target, context.slicing)
}
