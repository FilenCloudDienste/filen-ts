import { scriptForLanguage } from "../../../core/docx/theme/index"
import { FontManager, type FontRequest } from "../../../core/fonts/index"
import { partKey, type Relationships, type Slicing, type ZipEntry } from "../../../core/opc/index"
import { imageWithinBudget } from "../../../core/opc/mediaPolicy"
import type { PresentationBudgets } from "../../../core/presentation/budget"
import { PresentationError, refused, type ShapeRef, type SlideNode, type SlideRef } from "../../../core/presentation/model"
import type { SlideRender } from "../../../core/presentation/output"
import type { RenderServices, TextLayoutRequest, TextLayoutResult } from "../../../core/presentation/render/services"
import { renderSlide } from "../../../core/presentation/render/slide"
import { fontRequests, layoutBody, type TextEnvironment } from "../../../core/presentation/text/body"
import { resolveBody, shapeBodyContext, type BodyContext, type TextFonts } from "../../../core/presentation/text/resolve"
import { effectiveClrMap, resolveColor, themeOf, themeTypeface, toRgba, type PresentationTheme } from "../../../core/presentation/theme"
import { MeasureCache } from "../../../core/text/index"
import type { XmlDocument } from "../../../core/xml/index"
import type { DocxFontFace } from "../../docx/protocol"
import type { CallContext, EngineSession, ViewCapability } from "../engine"
import { presentationRealm, type PresentationRealm } from "../services"
import type { ShapeTextContext, TextServices } from "./text"
import { odpParts } from "./open/odp"
import { pptxParts } from "./open/pptx"

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

const states = new WeakMap<EngineSession, ViewState>()

function stateOf(session: EngineSession): ViewState {
	const held = states.get(session)
	const parts = viewParts(session.deck)

	if (held !== undefined && held.parts === parts) return held
	if (parts === undefined) throw new PresentationError("notImplemented", "render")

	const documents = new Map<string, XmlDocument | null>()
	const relationships = new Map<string, Relationships>()
	const realm = presentationRealm()
	const text: ViewText | undefined =
		realm === undefined
			? undefined
			: (() => {
					const fonts = new FontManager(realm.text.fontHost, realm.text.fontAssets)

					return {
						realm,
						fonts,
						environment: { fonts, cache: new MeasureCache(realm.text.measurer) },
						prepared: new Set<string>(),
						missing: new Map<string, FontRequest>(),
						replayed: 0,
						capture: undefined,
						shapes: new Map()
					}
				})()
	const services: RenderServices = {
		xml: part => parts.document(part) ?? documents.get(partKey(part)) ?? undefined,
		relationship(part, id) {
			const relationship = relationships.get(partKey(part))?.byId(id)

			if (relationship === undefined) return undefined

			return relationship.external || relationship.partName === undefined
				? { target: relationship.target, external: true, type: relationship.type }
				: { target: `/${relationship.partName}`, external: false, type: relationship.type }
		},
		contentType: part => parts.contentTypes.typeOf(partKey(part)),
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

	session.onClose(() => {
		documents.clear()
		relationships.clear()
		text?.shapes.clear()
		// A worker's faces only served measuring: the page has its own copies.
		text?.fonts.dispose()
		states.delete(session)
	})

	states.set(session, state)

	return state
}

function isXml(type: string | undefined): boolean {
	return type !== undefined && (type.endsWith("+xml") || type.endsWith("/xml"))
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

	state.documents.set(partKey(styles.partName), await state.parts.opc.xml(styles.partName, context.slicing))
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

				state.documents.set(key, fits ? await parts.opc.xml(key, context.slicing) : null)
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

function layoutRequest(parts: ViewParts, text: ViewText, request: TextLayoutRequest): TextLayoutResult | undefined {
	const capture = text.capture

	if (capture !== undefined && capture.shape.slide === request.slide.ref && capture.shape.id === request.shape.id)
		capture.request = request

	const resolved = resolveBody(request.body, bodyContextOf(parts, request))

	for (const font of fontRequests(resolved)) {
		const key = requestKey(font)

		if (!text.prepared.has(key)) text.missing.set(key, font)
	}

	const index = request.deck.slides.indexOf(request.slide.ref)
	const result = layoutBody(resolved, { width: request.width, height: request.height }, text.environment, {
		fields: { slideNumber: request.deck.firstSlideNumber + Math.max(0, index), now: new Date() },
		hyperlinks: true,
		// Table cells keep the face's own line height (LibreOffice 7.5, measured).
		...(request.cell === undefined ? {} : { lineMetrics: "face" as const })
	})

	return { page: result.page, height: result.height }
}

// Loads the faces text asked for and sends the page the ones newly registered; whether any was missing.
async function prepareFaces(session: EngineSession, text: ViewText, requests: Iterable<FontRequest>): Promise<boolean> {
	const wanted = [...requests].filter(request => !text.prepared.has(requestKey(request)))

	if (wanted.length === 0) return false

	await text.fonts.prepare(wanted)

	for (const request of wanted) text.prepared.add(requestKey(request))

	const registrations = text.fonts.registrations()
	const faces: DocxFontFace[] = []

	for (; text.replayed < registrations.length; text.replayed++) {
		const registration = registrations[text.replayed]

		if (registration === undefined) continue

		const face = { family: registration.family, weight: registration.weight, italic: registration.italic }

		if (registration.source === "asset")
			faces.push({ kind: "bytes", face, bytes: await text.realm.text.fontAssets.read(registration.file) })
		else if (registration.source === "local") faces.push({ kind: "local", face, name: registration.name })
	}

	if (faces.length > 0) session.emit({ type: "fonts", faces })

	return true
}

// One slide rendered (the thumbnails and the jobs worker render through it too).
export async function renderSlideFor(context: CallContext, ref: SlideRef): Promise<SlideRender> {
	const state = stateOf(context.session)

	if (!context.session.deck.slides.includes(ref)) throw new PresentationError("notFound", "slide")

	await prepare(context, state, ref)

	const render = await renderSlide(context.session.deck, ref, state.services, context.slicing)
	const text = state.text

	if (text === undefined || text.missing.size === 0) return render

	const missing = [...text.missing.values()]

	text.missing.clear()

	return (await prepareFaces(context.session, text, missing))
		? renderSlide(context.session.deck, ref, state.services, context.slicing)
		: render
}

// The text context of one shape for the editor's layoutText: what the render resolved for its body (chain, theme,
// box), read once per slide revision.
export const presentationTextServices: TextServices = {
	async shapeText(session, shape, slicing) {
		const state = stateOf(session)
		const text = state.text

		if (text === undefined) return refused("notImplemented", "text needs a measuring realm")

		const key = `${String(shape.slide)}:${String(shape.id)}`
		const node = session.deck.nodes.get(shape.slide) ?? (await state.parts.slide(shape.slide, slicing))
		let held = text.shapes.get(key)

		if (held === undefined || held.revision !== node.revision) {
			const signal = { aborted: false, onAbort: () => undefined }
			const capture: NonNullable<ViewText["capture"]> = { shape, request: undefined }

			text.capture = capture

			try {
				await renderSlideFor({ session, signal, lane: "priority", slicing }, shape.slide)
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
					slideNumber: session.deck.firstSlideNumber + Math.max(0, session.deck.slides.indexOf(shape.slide)),
					now: new Date()
				},
				hyperlinks: true,
				...(request.cell === undefined ? {} : { lineMetrics: "face" as const })
			},
			revision: held.revision
		}

		return answer
	}
}

const IMAGE_TYPES = /^image\/(?:png|jpeg|gif|bmp|webp|svg\+xml|tiff|x-emf|x-wmf|emf|wmf)$/u

// An image part's bytes and type; null when the package has none (or the part is not an image). Decks of the other
// formats are refused until their readers serve pictures.
export async function readImage(
	session: EngineSession,
	part: string
): Promise<{ readonly bytes: Uint8Array; readonly type: string } | null> {
	const parts = viewParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "image")

	const key = partKey(part)
	const type = parts.contentTypes.typeOf(key)?.toLowerCase()
	const entry = parts.opc.entry(key)

	if (type === undefined || !IMAGE_TYPES.test(type) || entry === undefined || entry.uncompressedSize > MAX_IMAGE_BYTES) return null

	const bytes = await parts.opc.read(key)

	// Held to the decoded-pixel budget from its header, before the page decodes it.
	return imageWithinBudget(bytes, parts.budgets) ? { bytes, type } : null
}

export async function readPart(session: EngineSession, part: string): Promise<Uint8Array | null> {
	return (await readImage(session, part))?.bytes ?? null
}

export const viewCapability: ViewCapability = {
	async render(context, refs) {
		// A deck no reader of this capability opened is refused before its arguments are looked at.
		stateOf(context.session)

		if (refs.length > MAX_RENDER_REFS) throw new PresentationError("tooLarge", "render")

		const out: SlideRender[] = []

		for (const ref of refs) {
			if (context.signal.aborted) throw new PresentationError("aborted", "render")

			out.push(await renderSlideFor(context, ref))
		}

		return out
	},
	image: (context, part) => readImage(context.session, part)
}
