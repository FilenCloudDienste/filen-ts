import { heldOdpMedia } from "../../../core/odp/write/save"
import { releasedMediaBytes, releasedMediaRelationship } from "../../../core/pptx/write/parts"
import { scriptForLanguage } from "../../../core/docx/theme/index"
import { FontManager, type FontRequest } from "../../../core/fonts/index"
import { partKey, type Relationships, type Slicing, type ZipEntry } from "../../../core/opc/index"
import { imageWithinBudget } from "../../../core/opc/mediaPolicy"
import type { PresentationBudgets } from "../../../core/presentation/budget"
import { insertedImage, insertedImageWritten } from "../../../core/presentation/edit/apply/picture"
import { chartDocument, chartRelationshipOwner } from "../../../core/presentation/edit/apply/chart"
import { diagramRelationshipOwner } from "../../../core/presentation/edit/apply/smartart"
import { prepareSlideMedia } from "../media"
import { cloneModel } from "../../../core/presentation/edit/changes"
import {
	PresentationError,
	refused,
	type Deck,
	type ShapeRef,
	type SlideNode,
	type SlideRef,
	type TextBody
} from "../../../core/presentation/model"
import type { SlideRender } from "../../../core/presentation/output"
import type { RenderServices, TextLayoutRequest, TextLayoutResult } from "../../../core/presentation/render/services"
import type { PlaceholderPrompts } from "../../../core/presentation/render/prompts"
import { renderSlide, type RenderOptions } from "../../../core/presentation/render/slide"
import { fontRequests, layoutBody, type TextEnvironment } from "../../../core/presentation/text/body"
import { resolveBody, shapeBodyContext, type BodyContext, type TextFonts } from "../../../core/presentation/text/resolve"
import { effectiveClrMap, resolveColor, themeOf, themeTypeface, toRgba, type PresentationTheme } from "../../../core/presentation/theme"
import type { DataPoint } from "../../../core/smartart/data"
import { smartArtFontRequests, textAdapterMeasurer, type TextMeasurer } from "../../../core/smartart/measure"
import { MeasureCache } from "../../../core/text/index"
import type { XmlDocument } from "../../../core/xml/index"
import { XmlError } from "../../../core/xml/errors"
import type { DocxFontFace } from "../../docx/protocol"
import type { ShadedPng } from "../protocol"
import type { CallContext, EngineSession, ViewCapability } from "../engine"
import { presentationRealm, type PresentationRealm, type RasterCanvas } from "../services"
import { ShadeJob, type ShadedMesh, type ShadedRaster } from "../../../core/drawingml/shade"
import { sliceClock } from "../../../core/slicing"
import { PngSteps } from "../../../core/drawingml/shadePng"
import type { ShapeTextContext, TextServices } from "./text"
import { odpParts } from "./open/odp"
import { pptxParts } from "./open/pptx"
import { smartArtRenderer } from "./smartart"
import { declareEmbeddedFonts, embeddedFaceBytes, loadEmbeddedFaces } from "./fonts"

// Slide renders for the page's SVG canvas, the raster path and the jobs worker: each slide parsed with its layout,
// master and notes (parse before touch), the XML parts its frames draw from (charts, diagrams) read ahead, then
// rendered by core/presentation/render. Pictures reach the page through image(part), as bytes of an image part.
//
// Text is laid out in this realm (the session's one measuring realm): each body resolved along its placeholder chain
// (presentation defaults, the master's text styles, the master and layout placeholders' list styles, the body's own)
// and laid out by core/presentation/text. Layout is synchronous, so faces are prepared ahead: a slide whose text
// asked for a face not loaded yet is laid out again once it is, and the new faces are sent to the page ("fonts").

// Slides per render call (the page asks for the visible window).
const MAX_RENDER_REFS = 64
// Parts read ahead for one slide's frames, and how deep relationships are followed from the slide's levels.
const MAX_AHEAD_PARTS = 256
const AHEAD_DEPTH = 2
// The largest picture image() hands out.
const MAX_IMAGE_BYTES = 64 * 1024 * 1024

// What this capability reads of a deck's package, whichever reader opened it (core/pptx PptxParts, core/odp OdpParts):
// parsed documents, the lazy node parse, themes, content types and the package's streams.
export interface ViewParts {
	readonly budgets: PresentationBudgets
	readonly contentTypes: { typeOf(name: string): string | undefined }
	readonly opc: {
		entry(name: string): ZipEntry | undefined
		has(name: string): boolean
		read(name: string, slicing?: Slicing): Promise<Uint8Array>
		xml(name: string, slicing?: Slicing): Promise<XmlDocument>
		relationships(name: string): Promise<Relationships>
	}
	document(part: string): XmlDocument | undefined
	theme(part: string): PresentationTheme | undefined
	refOf(part: string): SlideRef | undefined
	slide(ref: SlideRef, slicing?: Slicing): Promise<SlideNode>
}

export function viewParts(deck: Parameters<typeof pptxParts>[0]): ViewParts | undefined {
	return pptxParts(deck) ?? odpParts(deck)
}

interface ViewText {
	readonly realm: PresentationRealm
	readonly fonts: FontManager
	readonly environment: TextEnvironment
	readonly prepared: Set<string>
	readonly missing: Map<string, FontRequest>
	// The face preparation in flight (a render that found nothing missing waits for it when it ran meanwhile).
	pending: Promise<boolean> | undefined
	// Registrations of `fonts` already sent to the page.
	replayed: number
	// The request of one shape's body, captured during a render (shapeText).
	capture: { readonly shape: ShapeRef; request: TextLayoutRequest | undefined } | undefined
	// shapeText answers by shape, at the slide revision they were read at.
	readonly shapes: Map<string, { readonly revision: number; readonly request: TextLayoutRequest }>
}

interface ViewState {
	readonly parts: ViewParts
	readonly text: ViewText | undefined
	// XML of parts outside the deck's own nodes (charts, diagram parts, chart styles), by part key.
	readonly documents: Map<string, XmlDocument | null>
	readonly relationships: Map<string, Relationships>
	// Set again once the presentation's table styles are located (before the first render).
	services: RenderServices
	located: boolean
}

// Per session, the state of each reading of its deck (an ODP rebase reads the saved file anew): a reading the deck no
// longer holds is let go with its state, never kept until the next render.
const states = new WeakMap<EngineSession, WeakMap<ViewParts, ViewState>>()
// The session's measuring, carried from one reading to the next: faces come from the realm, not the file, so a save
// neither prepares them again nor sends them to the page again.
const texts = new WeakMap<EngineSession, ViewText>()

function stateOf(session: EngineSession): ViewState {
	const parts = viewParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "render")

	let readings = states.get(session)
	const held = readings?.get(parts)

	if (held !== undefined) return held

	const documents = new Map<string, XmlDocument | null>()
	const relationships = new Map<string, Relationships>()
	const realm = presentationRealm()
	const kept = texts.get(session)

	if (kept !== undefined) {
		// Its answers were read from the previous reading.
		kept.shapes.clear()
		kept.capture = undefined

		if (kept.realm !== realm) kept.fonts.dispose()
	}

	const text: ViewText | undefined =
		kept !== undefined && kept.realm === realm
			? kept
			: realm === undefined
				? undefined
				: (() => {
						const fonts = new FontManager(realm.text.fontHost, realm.text.fontAssets)

						// The deck's embedded fonts, each decoded when text first needs it.
						declareEmbeddedFonts(session, fonts, async (part, limit) => {
							const key = partKey(part)
							const entry = parts.opc.entry(key)

							return entry === undefined || entry.uncompressedSize > limit ? undefined : await parts.opc.read(key)
						})

						return {
							realm,
							fonts,
							environment: { fonts, cache: new MeasureCache(realm.text.measurer) },
							prepared: new Set<string>(),
							missing: new Map<string, FontRequest>(),
							pending: undefined,
							replayed: 0,
							capture: undefined,
							shapes: new Map()
						}
					})()
	const services: RenderServices = {
		xml: part => chartDocument(session.deck, part) ?? parts.document(part) ?? documents.get(partKey(part)) ?? undefined,
		relationship(part, id) {
			// A held diagram edit's pictures are its package data part's relationships; a held chart's, its home part's.
			const owner = diagramRelationshipOwner(session.deck, part) ?? chartRelationshipOwner(session.deck, part) ?? part
			const relationship = relationships.get(partKey(owner))?.byId(id)

			if (relationship === undefined) {
				// Media a save let go of that an undo put back: related as before until the next save writes them again.
				const released = releasedMediaRelationship(session.deck, owner, id)

				return released === undefined ? undefined : { target: `/${released.name}`, external: false, type: released.type }
			}

			return relationship.external || relationship.partName === undefined
				? { target: relationship.target, external: true, type: relationship.type }
				: { target: `/${relationship.partName}`, external: false, type: relationship.type }
		},
		contentType: part => insertedContentType(session.deck, part) ?? parts.contentTypes.typeOf(partKey(part)),
		budgets: parts.budgets,
		// EMF/WMF pictures and OLE previews, converted into the drawing by the renderer.
		async bytes(part, limit) {
			const key = partKey(part)
			const entry = parts.opc.entry(key)

			return entry === undefined || entry.uncompressedSize > limit ? undefined : await parts.opc.read(key)
		},
		...(text === undefined ? {} : { layoutText: request => layoutRequest(parts, text, request) })
	}
	const state: ViewState = { parts, text, documents, relationships, services, located: false }

	// Diagrams without a drawing cache are laid out by the SmartArt engine over the session's current reading and this
	// text adapter (the host the engine keeps for the session reaches no reading a rebase replaced).
	state.services = {
		...services,
		smartart: smartArtRenderer(session, smartArtHost(session, text))
	}

	if (readings === undefined) {
		readings = new WeakMap()
		states.set(session, readings)
		releaseOnClose(session)
	}

	readings.set(parts, state)

	if (text === undefined) texts.delete(session)
	else texts.set(session, text)

	return state
}

// Once per session, apart from stateOf (whose closures hold a reading): whatever the session holds when it closes.
function releaseOnClose(session: EngineSession): void {
	session.onClose(() => {
		const current = viewParts(session.deck)
		const last = current === undefined ? undefined : states.get(session)?.get(current)

		last?.documents.clear()
		last?.relationships.clear()
		texts.get(session)?.shapes.clear()
		// A worker's faces only served measuring: the page has its own copies.
		texts.get(session)?.fonts.dispose()
		texts.delete(session)
		states.delete(session)
	})
}

// Built apart from stateOf so that its closures hold the session and its measuring only, never a reading.
function smartArtHost(session: EngineSession, text: ViewText | undefined): Parameters<typeof smartArtRenderer>[1] {
	return {
		get services() {
			return stateOf(session).services
		},
		...(text === undefined
			? {}
			: {
					measurer: (slide: SlideNode, texts: readonly (string | DataPoint)[]) =>
						smartArtMeasurer(stateOf(session).parts, text, session, slide, texts),
					fontGeneration: () => text.prepared.size
				})
	}
}

// A part the renderer reads as XML: an XML content type, pictures aside (an SVG picture is drawn from its bytes, and
// Illustrator's carry an internal DTD subset the XML reader refuses).
function isXml(type: string | undefined): boolean {
	return type !== undefined && !type.startsWith("image/") && (type.endsWith("+xml") || type.endsWith("/xml"))
}

// A related part read as XML, or null when it is not well-formed: the renderer then draws without it (a picture its
// fallback, a table its own formatting), as for a part over the budget.
async function readableXml(parts: ViewParts, key: string, slicing: Slicing): Promise<XmlDocument | null> {
	try {
		return await parts.opc.xml(key, slicing)
	} catch (error) {
		if (error instanceof XmlError) return null

		throw error
	}
}

async function relationshipsOf(state: ViewState, part: string): Promise<Relationships> {
	const key = partKey(part)
	const held = state.relationships.get(key)

	if (held !== undefined) return held

	const read = await state.parts.opc.relationships(key)

	state.relationships.set(key, read)

	return read
}

const OFFICE_DOCUMENT = /\/officeDocument$/u
const TABLE_STYLES = /\/tableStyles$/u

// The presentation's tableStyles part (§19.3.3.1), read into the documents the renderer reads.
async function locateTableStyles(context: CallContext, state: ViewState): Promise<void> {
	if (state.located) return

	state.located = true

	const main = (await relationshipsOf(state, "")).all.find(
		relationship => !relationship.external && OFFICE_DOCUMENT.test(relationship.type)
	)

	if (main?.partName === undefined) return

	const styles = (await relationshipsOf(state, main.partName)).all.find(
		relationship => !relationship.external && TABLE_STYLES.test(relationship.type)
	)

	if (styles?.partName === undefined || !state.parts.opc.has(styles.partName)) return

	const entry = state.parts.opc.entry(styles.partName)

	if (entry === undefined || entry.uncompressedSize > state.parts.budgets.xmlPartBytes) return

	const document = await readableXml(state.parts, styles.partName, context.slicing)

	// A table style part that does not read is no table style part.
	if (document === null) return

	state.documents.set(partKey(styles.partName), document)
	state.services = { ...state.services, tableStylesPart: `/${styles.partName}` }
}

// The slide, its layout, master and notes parsed, their relationships and the XML their frames draw from read.
async function prepare(context: CallContext, state: ViewState, ref: SlideRef): Promise<void> {
	const { parts } = state

	await locateTableStyles(context, state)

	const deck = context.session.deck
	const node = await parts.slide(ref, context.slicing)
	const levels: SlideNode[] = []

	for (let at: SlideNode | undefined = node; at !== undefined && levels.length < 8;) {
		levels.push(at)
		at = at.parent === undefined ? undefined : (deck.nodes.get(at.parent) ?? (await parts.slide(at.parent, context.slicing)))
	}

	if (node.notes !== undefined) levels.push(deck.nodes.get(node.notes) ?? (await parts.slide(node.notes, context.slicing)))

	const seen = new Set<string>()
	let frontier = levels.map(level => level.part)

	for (let depth = 0; depth <= AHEAD_DEPTH && frontier.length > 0; depth++) {
		const next: string[] = []

		for (const part of frontier) {
			const key = partKey(part)

			if (seen.has(key) || seen.size >= MAX_AHEAD_PARTS) continue

			seen.add(key)

			if (!parts.opc.has(key)) continue

			if (parts.document(part) === undefined && !state.documents.has(key)) {
				const entry = parts.opc.entry(key)
				const fits =
					entry !== undefined && isXml(parts.contentTypes.typeOf(key)) && entry.uncompressedSize <= parts.budgets.xmlPartBytes

				state.documents.set(key, fits ? await readableXml(parts, key, context.slicing) : null)
			}

			for (const relationship of (await relationshipsOf(state, part)).all) {
				if (
					relationship.external ||
					relationship.partName === undefined ||
					!isXml(parts.contentTypes.typeOf(relationship.partName))
				)
					continue

				// The deck's own nodes are parsed through the parts (slides are never read ahead from another slide).
				if (parts.refOf(`/${relationship.partName}`) !== undefined) continue

				next.push(`/${relationship.partName}`)
			}
		}

		frontier = next
	}

	if (context.signal.aborted) throw new PresentationError("aborted", "render")
}

function requestKey(request: FontRequest): string {
	return `${request.family.toLowerCase()}\u0000${request.bold ? 1 : 0}${request.italic ? 1 : 0}${request.slot}`
}

// What a body inherits: the one resolver's chain (core/presentation/text/resolve.ts shapeBodyContext) with the
// slide's theme fonts and colours.
export function bodyContextOf(parts: ViewParts, request: TextLayoutRequest): BodyContext {
	const { deck } = request
	const themeRef = themeOf(deck.nodes, request.owner)
	const theme = themeRef === undefined ? undefined : parts.theme(themeRef.part)
	const clrMap = effectiveClrMap(deck.nodes, request.slide)
	const fonts: TextFonts = {
		color: color => {
			const resolved = resolveColor(color, { theme, clrMap })

			return resolved === undefined ? undefined : toRgba(resolved)
		},
		typeface: (typeface, lang) => themeTypeface(theme, typeface, scriptForLanguage(lang))
	}

	return shapeBodyContext(deck, request.owner, request.shape, fonts, request.bodyPr, request.cell)
}

// The theme fonts and colours text of `slide` resolves against.
function slideFonts(parts: ViewParts, deck: Deck, slide: SlideNode): TextFonts {
	const themeRef = themeOf(deck.nodes, slide)
	const theme = themeRef === undefined ? undefined : parts.theme(themeRef.part)
	const clrMap = effectiveClrMap(deck.nodes, slide)

	return {
		color: color => {
			const resolved = resolveColor(color, { theme, clrMap })

			return resolved === undefined ? undefined : toRgba(resolved)
		},
		typeface: (typeface, lang) => themeTypeface(theme, typeface, scriptForLanguage(lang))
	}
}

// A SmartArt measurer over the slide text adapter; the faces it needs are requested like a body's (the render that
// asked is redone once they are loaded, and the engine's cache keys on fontGeneration).
function smartArtMeasurer(
	parts: ViewParts,
	text: ViewText,
	session: EngineSession,
	slide: SlideNode,
	texts: readonly (string | DataPoint)[]
): TextMeasurer {
	const fonts = slideFonts(parts, session.deck, slide)

	for (const font of smartArtFontRequests(texts, fonts)) {
		const key = requestKey(font)

		if (!text.prepared.has(key)) text.missing.set(key, font)
	}

	return textAdapterMeasurer(text.environment, fonts)
}

function layoutRequest(parts: ViewParts, text: ViewText, request: TextLayoutRequest): TextLayoutResult | undefined {
	const capture = text.capture
	const own = request.cell === undefined
	const wanted = capture?.shape.cell

	// A layer names the node that owns its shape (a layout's or master's shape drawn on a slide names that layout or
	// master), so the slide shape's own body is the one captured; a table cell's body is captured for that cell only.
	if (
		capture !== undefined &&
		request.prompt !== true &&
		capture.shape.slide === request.owner.ref &&
		capture.shape.id === request.shape.id &&
		(wanted === undefined ? own : request.cell?.row === wanted.row && request.cell.column === wanted.col)
	)
		capture.request = request

	// A shape body with nothing visible in it paints nothing: the render hands it over only so the editor can enter it.
	if (own && !visibleText(request.body)) return undefined

	// A table cell's text laid out before, unchanged (its body is the same object until an edit replaces it): a copy
	// of that layout (the answer transfers its buffers), so a one-cell edit lays out one cell.
	// A row's measure (height 0: only the laid-out height is read, the page is never sent) takes the held layout as
	// it is; a held layout whose buffers went with an answer anyway is laid out again.
	const cellKey = request.cell === undefined ? undefined : cellLayoutKey(request)
	const measure = request.cell !== undefined && request.height === 0
	const held = cellKey === undefined ? undefined : cellLayouts.get(request.body)?.get(cellKey)

	if (held !== undefined && !detached(held)) return measure ? held : copyCellLayout(held)

	const resolved = resolveBody(request.body, bodyContextOf(parts, request))
	// Whether a face this body names is not prepared yet (an earlier cell of the same render may already have asked
	// for it, so the missing set alone does not tell).
	let unprepared = false

	for (const font of fontRequests(resolved)) {
		const key = requestKey(font)

		if (!text.prepared.has(key)) {
			text.missing.set(key, font)
			unprepared = true
		}
	}

	const index = slideIndexOf(request.deck, request.slide)
	const result = layoutBody(resolved, { width: request.width, height: request.height }, text.environment, {
		fields: { slideNumber: request.deck.firstSlideNumber + Math.max(0, index), now: new Date() },
		hyperlinks: true,
		// ODF shrink-to-fit names no scale: LibreOffice finds it as it lays the text out.
		...(request.deck.format === "odp" ? { shrinkOnLayout: true } : {}),
		// Table cells keep the face's own line height (LibreOffice 7.5, measured).
		...(request.cell === undefined ? {} : { lineMetrics: "face" as const })
	})
	const answer = { page: result.page, height: result.height }

	// Laid out with every face it names (a missing one renders the slide again once loaded).
	if (cellKey !== undefined && !unprepared) {
		let layouts = cellLayouts.get(request.body)

		// A render lays a cell out twice (its row's height, then its box): two entries, a box change drops the rest.
		if (layouts === undefined || layouts.size >= 2) {
			layouts = new Map()
			cellLayouts.set(request.body, layouts)
		}

		layouts.set(cellKey, measure ? answer : copyCellLayout(answer))
	}

	return answer
}

// Whether a layout's buffers were transferred away (a detached buffer reads as empty).
function detached(layout: TextLayoutResult): boolean {
	const page = layout.page.page

	return page.fragmentCount > 0 && page.fragmentInts.length === 0
}

const cellLayouts = new WeakMap<TextBody, Map<string, TextLayoutResult>>()

// A held cell layout apart from the answer that transfers its buffers: every typed array copied, the values nothing
// changes (strings, numbers, the style rows) shared; the few paints, strokes and effects copied whole (a shaded paint
// or a custom dash holds a typed array).
function copyCellLayout(layout: TextLayoutResult): TextLayoutResult {
	const text = layout.page
	const page: Record<string, unknown> = { ...text.page }

	for (const key in page) {
		const value = page[key]

		if (ArrayBuffer.isView(value)) page[key] = (value as Uint8Array).slice()
	}

	return {
		height: layout.height,
		page: {
			...text,
			page: page as unknown as TextLayoutResult["page"]["page"],
			paints: cloneModel(text.paints),
			strokes: cloneModel(text.strokes),
			textEffects: cloneModel(text.textEffects),
			...(text.markers === undefined ? {} : { markers: text.markers.slice() })
		}
	}
}

// What a cell's layout depends on beside its body: its box, its table style's text, the deck's text defaults, its
// slide's layout and master (their text styles and theme).
function cellLayoutKey(request: TextLayoutRequest): string {
	const layout = request.slide.parent === undefined ? undefined : request.deck.nodes.get(request.slide.parent)
	const master = layout?.parent === undefined ? undefined : request.deck.nodes.get(layout.parent)
	const style = request.cell?.style

	return [
		request.width,
		request.height,
		request.deck.revision,
		layout?.revision,
		master?.revision,
		master?.theme?.revision,
		style?.bold,
		style?.italic,
		style?.color,
		style?.font
	].join("|")
}

function visibleText(body: TextLayoutRequest["body"]): boolean {
	return body.paragraphs.some(paragraph => paragraph.runs.some(run => run.kind !== "br" && run.text !== ""))
}

function slideIndexOf(deck: EngineSession["deck"], node: TextLayoutRequest["slide"]): number {
	const index = deck.slides.indexOf(node.ref)

	if (index >= 0 || node.kind !== "notes") return index

	return deck.slides.findIndex(ref => deck.nodes.get(ref)?.notes === node.ref)
}

// Loads the faces text asked for and sends the page the ones newly registered; whether any was missing.
async function prepareFaces(session: EngineSession, text: ViewText, requests: Iterable<FontRequest>): Promise<boolean> {
	const wanted = [...requests].filter(request => !text.prepared.has(requestKey(request)))

	if (wanted.length === 0) return false

	await text.fonts.prepare(wanted)

	for (const request of wanted) text.prepared.add(requestKey(request))

	const registrations = text.fonts.registrations()
	const faces: DocxFontFace[] = []

	// The registrations not yet sent are claimed before anything is awaited: concurrent preparations (a render, the
	// thumbnails, the editor's text) share the counter, and an await inside the loop would let each advance it past
	// faces another one registered meanwhile, which then never reach the page.
	const from = text.replayed
	const to = registrations.length

	text.replayed = to

	for (let index = from; index < to; index++) {
		const registration = registrations[index]

		if (registration === undefined) continue

		const face = { family: registration.family, weight: registration.weight, italic: registration.italic }

		if (registration.source === "asset")
			faces.push({ kind: "bytes", face, bytes: await text.realm.text.fontAssets.read(registration.file) })
		else if (registration.source === "local") faces.push({ kind: "local", face, name: registration.name })
		else {
			// Sent as a copy: the session keeps the decoded font for later sends.
			const bytes = embeddedFaceBytes(session, registration)

			if (bytes !== undefined) faces.push({ kind: "bytes", face, bytes: bytes.slice() })
		}
	}

	if (faces.length > 0) session.emit({ type: "fonts", faces })

	return true
}

// One slide rendered (the thumbnails and the jobs worker render through it too, without options).
export async function renderSlideFor(context: CallContext, ref: SlideRef, options?: RenderOptions): Promise<SlideRender> {
	if (!context.session.deck.slides.includes(ref)) throw new PresentationError("notFound", "slide")

	return renderNodeFor(context, ref, options)
}

// The open's prompt strings when the deck can be edited: the editor's view asks for them (render's `prompts`).
function editorPrompts(session: EngineSession): PlaceholderPrompts | undefined {
	const prompts = session.options.prompts

	if (prompts === undefined || session.options.viewOnly === true || session.package.viewOnly === true) return undefined

	return session.deck.gate.length === 0 ? prompts : undefined
}

export async function sessionFaces(session: EngineSession): Promise<DocxFontFace[]> {
	const text = stateOf(session).text

	if (text === undefined) return []

	// An export takes the font list before it lays out its pages: the deck's embedded faces are loaded first.
	await loadEmbeddedFaces(session)

	const faces: DocxFontFace[] = []

	for (const registration of text.fonts.registrations()) {
		const face = { family: registration.family, weight: registration.weight, italic: registration.italic }

		if (registration.source === "asset")
			faces.push({ kind: "bytes", face, bytes: await text.realm.text.fontAssets.read(registration.file) })
		else if (registration.source === "local") faces.push({ kind: "local", face, name: registration.name })
		else {
			const bytes = embeddedFaceBytes(session, registration)

			if (bytes !== undefined) faces.push({ kind: "bytes", face, bytes })
		}
	}

	return faces
}

export async function renderNodeFor(context: CallContext, ref: SlideRef, options?: RenderOptions): Promise<SlideRender> {
	const state = stateOf(context.session)

	await prepare(context, state, ref)

	const again = (): Promise<SlideRender> => renderSlide(context.session.deck, ref, state.services, context.slicing, undefined, options)
	const render = await again()
	const text = state.text

	if (text === undefined) return render

	if (text.missing.size === 0) {
		// Another render took the missing faces this one also asked for: wait for them as it does.
		const pending = text.pending

		return pending !== undefined && (await pending) ? again() : render
	}

	const missing = [...text.missing.values()]

	text.missing.clear()

	const pending = prepareFaces(context.session, text, missing)

	text.pending = pending

	try {
		return (await pending) ? again() : render
	} finally {
		if (text.pending === pending) text.pending = undefined
	}
}

// The text context of one shape for the editor's layoutText: what the render resolved for its body (chain, theme,
// box), read once per slide revision.
export const presentationTextServices: TextServices = {
	async shapeText(session, shape, slicing) {
		const state = stateOf(session)
		const text = state.text

		if (text === undefined) return refused("notImplemented", "text needs a measuring realm")

		const key = `${String(shape.slide)}:${String(shape.id)}${shape.cell === undefined ? "" : `:${String(shape.cell.row)}:${String(shape.cell.col)}`}`
		const node = session.deck.nodes.get(shape.slide) ?? (await state.parts.slide(shape.slide, slicing))
		let held = text.shapes.get(key)

		if (held === undefined || held.revision !== node.revision) {
			const signal = { aborted: false, onAbort: () => undefined }
			const capture: NonNullable<ViewText["capture"]> = { shape, request: undefined }

			text.capture = capture

			try {
				const render = node.kind === "notes" ? renderNodeFor : renderSlideFor

				await render({ session, signal, lane: "priority", slicing }, shape.slide)
			} finally {
				text.capture = undefined
			}

			if (capture.request === undefined) return refused("notFound", "the shape has no text body")

			held = { revision: node.revision, request: capture.request }
			text.shapes.set(key, held)
		}

		const request = held.request
		const answer: ShapeTextContext = {
			kind: "shapeText",
			context: bodyContextOf(state.parts, request),
			box: { width: request.width, height: request.height },
			environment: text.environment,
			prepare: async requests => {
				await prepareFaces(session, text, requests)
			},
			options: {
				fields: {
					slideNumber:
						session.deck.firstSlideNumber +
						Math.max(
							0,
							node.kind === "notes"
								? session.deck.slides.findIndex(ref => session.deck.nodes.get(ref)?.notes === shape.slide)
								: session.deck.slides.indexOf(shape.slide)
						),
					now: new Date()
				},
				hyperlinks: true,
				...(session.deck.format === "odp" ? { shrinkOnLayout: true } : {}),
				...(request.cell === undefined ? {} : { lineMetrics: "face" as const })
			},
			revision: held.revision
		}

		return answer
	}
}

const IMAGE_TYPES = /^image\/(?:png|jpeg|gif|bmp|webp|svg\+xml|tiff|x-emf|x-wmf|emf|wmf)$/u

// The type of an image an op inserted ("inserted:<id>", edit/apply/picture.ts), held or written by a save; undefined
// for any other part.
function insertedContentType(deck: Deck, part: string): string | undefined {
	if (!part.startsWith("inserted:")) return undefined

	const id = Number(part.slice("inserted:".length))

	return insertedImage(deck, id)?.contentType ?? insertedImageWritten(deck, id)?.contentType
}

// An image part's bytes and type; null when the package has none (or the part is not an image). Decks of the other
// formats are refused until their readers serve pictures.
export async function readImage(
	session: EngineSession,
	part: string
): Promise<{ readonly bytes: Uint8Array; readonly type: string } | null> {
	const parts = viewParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "image")

	// An image an op inserted, not stored yet (edit/apply/picture.ts): a copy, as the answer transfers its bytes. Once
	// a save wrote it, the part it was written to.
	if (part.startsWith("inserted:")) {
		const id = Number(part.slice("inserted:".length))
		const image = insertedImage(session.deck, id)

		if (image !== undefined) return { bytes: image.bytes.slice(), type: image.contentType }

		const written = insertedImageWritten(session.deck, id)

		return written === undefined ? null : readImage(session, written.part)
	}

	const key = partKey(part)
	const type = parts.contentTypes.typeOf(key)?.toLowerCase()
	const entry = parts.opc.entry(key)

	// An image a save let go of that an undo put back: the bytes the session holds for it.
	if (entry === undefined) {
		const held = heldImage(session.deck, part)

		return held === undefined || !IMAGE_TYPES.test(held.type.toLowerCase()) || !imageWithinBudget(held.bytes, parts.budgets)
			? null
			: { bytes: held.bytes.slice(), type: held.type }
	}

	if (type === undefined || !IMAGE_TYPES.test(type) || entry === undefined || entry.uncompressedSize > MAX_IMAGE_BYTES) return null

	const bytes = await parts.opc.read(key)

	// Held to the decoded-pixel budget from its header, before the page decodes it.
	return imageWithinBudget(bytes, parts.budgets) ? { bytes, type } : null
}

export async function readPart(session: EngineSession, part: string): Promise<Uint8Array | null> {
	return (await readImage(session, part))?.bytes ?? null
}

// A worker raster's pixels at most (the page asks within its own, smaller, budget).
const MAX_SHADE_RASTER_PIXELS = 4 * 1024 * 1024

export const viewCapability: ViewCapability = {
	async render(context, refs, options) {
		// A deck no reader of this capability opened is refused before its arguments are looked at.
		stateOf(context.session)

		if (refs.length > MAX_RENDER_REFS) throw new PresentationError("tooLarge", "render")

		const out: SlideRender[] = []
		const prompts = options?.prompts === true ? editorPrompts(context.session) : undefined
		const renderOptions = prompts === undefined ? undefined : { prompts }

		for (const ref of refs) {
			if (context.signal.aborted) throw new PresentationError("aborted", "render")

			out.push(await renderSlideFor(context, ref, renderOptions))
			// Its deflated media start preparing now, in the background lane.
			prepareSlideMedia(context.session, ref)
		}

		return out
	},
	image: (context, part) => readImage(context.session, part),
	shade: (context, meshes, scale, maxPixels) => shadeRasterFor(context, meshes, scale, maxPixels)
}

// A render's shaded meshes rasterised and encoded here, off the page's thread, in the call's slices: the raster the
// page planned (ShadeJob.plan of the same meshes, scale and pixels is deterministic, so its size and extent are the
// page's), as a PNG Blob through the realm's canvas encoder where it has one (OffscreenCanvas.convertToBlob), else
// through the sliced encoder.
async function shadeRasterFor(
	context: CallContext,
	meshes: readonly ShadedMesh[],
	scale: number,
	maxPixels: number
): Promise<ShadedPng | null> {
	const job = ShadeJob.plan(meshes, scale, Math.min(maxPixels, MAX_SHADE_RASTER_PIXELS))

	if (job === undefined) return null

	const clock = sliceClock(context.slicing)
	const check = (): void => {
		if (context.signal.aborted) throw new PresentationError("aborted", "shade")
	}

	check()

	while (!job.step(() => clock.due)) {
		await clock.pause()
		check()
	}

	const raster = job.result()
	const encoded = await canvasPng(raster)

	if (encoded !== undefined) return { png: encoded, bounds: raster.bounds }

	const Blob: unknown = Reflect.get(globalThis, "Blob")

	if (typeof Blob !== "function") throw new PresentationError("notImplemented", "shade: no Blob")

	const png = new PngSteps(raster.rgba, raster.width, raster.height)

	while (!png.step(() => clock.due)) {
		await clock.pause()
		check()
	}

	return {
		png: new (Blob as new (parts: readonly Uint8Array[], options: { readonly type: string }) => ShadedPng["png"])(png.result(), {
			type: "image/png"
		}),
		bounds: raster.bounds
	}
}

interface EncodingCanvas extends RasterCanvas {
	convertToBlob(options: { readonly type: string }): Promise<ShadedPng["png"]>
}

// The raster through the realm's canvas encoder (a worker's OffscreenCanvas encodes off its thread's slices);
// undefined where the realm has none.
async function canvasPng(raster: ShadedRaster): Promise<ShadedPng["png"] | undefined> {
	const ImageData: unknown = Reflect.get(globalThis, "ImageData")
	const canvas = presentationRealm()?.canvas.canvas(raster.width, raster.height)
	const ctx = canvas?.getContext("2d") ?? null
	const put: unknown = ctx === null ? undefined : Reflect.get(ctx, "putImageData")

	if (
		canvas === undefined ||
		ctx === null ||
		typeof ImageData !== "function" ||
		typeof put !== "function" ||
		typeof Reflect.get(canvas, "convertToBlob") !== "function"
	) {
		if (canvas !== undefined) release(canvas)

		return undefined
	}

	try {
		const pixels = new (ImageData as new (data: Uint8ClampedArray, width: number, height: number) => unknown)(
			new Uint8ClampedArray(raster.rgba.buffer as ArrayBuffer, raster.rgba.byteOffset, raster.rgba.length),
			raster.width,
			raster.height
		)

		Reflect.apply(put, ctx, [pixels, 0, 0])

		return await (canvas as EncodingCanvas).convertToBlob({ type: "image/png" })
	} finally {
		release(canvas)
	}
}

// An OffscreenCanvas has no close(): only a bitmap-like canvas of a test realm does.
function release(canvas: RasterCanvas): void {
	const close: unknown = Reflect.get(canvas, "close")

	if (typeof close === "function") Reflect.apply(close, canvas, [])
}

function heldImage(deck: EngineSession["deck"], part: string): { readonly bytes: Uint8Array; readonly type: string } | undefined {
	if (deck.format !== "odp") {
		const released = releasedMediaBytes(deck, part)

		return released === undefined ? undefined : { bytes: released.bytes, type: released.contentType }
	}

	const held = heldOdpMedia(deck, part)

	return held === undefined ? undefined : { bytes: held.bytes, type: held.mediaType }
}
