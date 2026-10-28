import { EMU_PER_PX } from "../../../core/drawingml/index"
import { metaTitle } from "../../../core/odf/meta"
import { coreTitle } from "../../../core/opc/coreTitle"
import { standardSecurityKey, type PdfSecurityKey } from "../../../core/pdfwrite/crypto"
import { PdfWriteError } from "../../../core/pdfwrite/errors"
import { findShape } from "../../../core/presentation/edit/changes"
import {
	PresentationError,
	type PresentationRefusal,
	type ShapeNode,
	type SlideNode,
	type SlideRef
} from "../../../core/presentation/model"
import type { SlideRender } from "../../../core/presentation/output"
import {
	defaultNotesSlideBox,
	type Box,
	type ExportLayerKind,
	type JobDeckInfo,
	type NotesPageExport,
	type SlideExport
} from "../../../core/presentation/pages"
import type { DocxFontFace } from "../../docx/protocol"
import type { CallContext, CallSignal, EngineSession, JobsCapability } from "../engine"
import { presentationTransferables, type PortLike } from "../protocol"
import { convertCapability } from "./convert"
import { mediaCapability } from "./media"
import { odpParts } from "./open/odp"
import { pptPassword } from "./open/ppt"
import { pptxPassword } from "./open/pptx"
import { readImage, renderNodeFor, renderSlideFor, sessionFaces, viewParts } from "./view"

// jobsPort(port): the presentation worker's side of a jobs worker (one per export or conversion). The jobs worker
// reads the open session through the port, unsaved edits included and never a serialized deck: renders, the deck's
// facts, what each layer is for a tagged PDF, notes pages, pictures, the faces the text was laid out in, and the PDF
// security of the source password (made here: the password never leaves this worker). Calls are answered in the
// background lane; the port is served until the jobs worker says "close" or the session closes.

// The calls a jobs worker makes on the port (jobs/registry.ts JobSession).
export type JobPortMethod =
	"render" | "media" | "freshParts" | "image" | "deckInfo" | "exportSlides" | "notesPage" | "faces" | "pdfSecurity"

export type ToJobsPort =
	{ readonly t: "call"; readonly id: number; readonly method: JobPortMethod; readonly args: readonly unknown[] } | { readonly t: "close" }

export type FromJobsPort =
	| { readonly t: "result"; readonly id: number; readonly value: unknown }
	| { readonly t: "refused"; readonly id: number; readonly reason: PresentationRefusal; readonly message: string }

// A MessagePort as both ends use it (the protocol's PortLike only sends).
export interface JobsPortEnd extends PortLike {
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
	removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
}

export function isJobsPortEnd(port: PortLike): port is JobsPortEnd {
	return (
		typeof port === "object" &&
		port !== null &&
		typeof Reflect.get(port, "addEventListener") === "function" &&
		typeof Reflect.get(port, "removeEventListener") === "function"
	)
}

const PH_KINDS: Readonly<Record<string, ExportLayerKind>> = {
	title: "title",
	ctrTitle: "title",
	sldNum: "number",
	dt: "date",
	ftr: "footer",
	hdr: "header",
	sldImg: "art"
}

// What each layer of a render is: a layout's or master's art; else by the node's own shape it draws.
export function layerKinds(node: SlideNode | undefined, render: SlideRender): ExportLayerKind[] {
	return render.layers.map((layer): ExportLayerKind => {
		if (layer.role === "master" || layer.role === "layout" || layer.shape.slide !== render.ref) return "art"

		const shape: ShapeNode | undefined = node === undefined ? undefined : findShape(node.shapes, layer.shape.id)?.shape
		const ph = shape?.ph?.type
		const placeholder = ph === undefined ? undefined : PH_KINDS[ph]

		if (placeholder !== undefined) return placeholder
		if (layer.role === "picture" || shape?.kind === "pic") return "picture"

		return layer.text === undefined ? "content" : "body"
	})
}

function exportOf(session: EngineSession, render: SlideRender): SlideExport {
	return { render, kinds: layerKinds(session.deck.nodes.get(render.ref), render) }
}

// The document's own title: an OPC package's core properties, an OpenDocument's meta.xml dc:title.
async function documentTitle(session: EngineSession): Promise<string | undefined> {
	const opc = session.package.opc

	if (opc !== undefined) return coreTitle(opc).catch(() => undefined)

	const odf = odpParts(session.deck)?.odf

	return odf === undefined ? undefined : metaTitle(odf)
}

// The deck's slides, sizes, title (its document title, else its file name's) and language (its default text style's,
// when it names one).
async function deckInfo(session: EngineSession): Promise<JobDeckInfo> {
	const deck = session.deck
	const title = await documentTitle(session)
	const style = deck.defaultTextStyle
	const lang = style.levels[0]?.defRPr?.lang ?? style.def?.defRPr?.lang

	return {
		slides: deck.slides.map(ref => ({ ref, hidden: deck.nodes.get(ref)?.hidden ?? deck.hiddenSlides?.has(ref) ?? false })),
		size: { cx: deck.size.cx, cy: deck.size.cy },
		notesSize: { cx: deck.notesSize.cx, cy: deck.notesSize.cy },
		// Untitled: its file name without the extension (a tagged PDF names a title).
		title: title !== undefined && title.trim() !== "" ? title.trim() : session.options.fileName.replace(/\.[^.]*$/u, ""),
		...(lang === undefined || lang === "" ? {} : { lang })
	}
}

function sldImgOf(node: SlideNode | undefined): ShapeNode | undefined {
	return node?.shapes.find(shape => shape.ph?.type === "sldImg")
}

function boxOf(shape: ShapeNode | undefined): Box | undefined {
	const xfrm = shape?.xfrm

	if (xfrm === undefined || !(xfrm.cx > 0) || !(xfrm.cy > 0)) return undefined

	return { x: xfrm.x / EMU_PER_PX, y: xfrm.y / EMU_PER_PX, width: xfrm.cx / EMU_PER_PX, height: xfrm.cy / EMU_PER_PX }
}

function emptyDrawing(width: number, height: number): SlideRender["background"] {
	return {
		width,
		height,
		commands: new Uint8Array(0),
		coords: new Float32Array(0),
		itemCount: 0,
		itemFloats: new Float32Array(0),
		itemInts: new Int32Array(0),
		paints: [],
		strokes: [],
		images: [],
		texts: [],
		shadows: []
	}
}

// A slide's notes page: its notes slide rendered, the slide image where its sldImg placeholder (or its master's) puts
// it; without one, the notes master's art alone (its placeholders left out); without a master, the slide in the
// default master's box.
async function notesPage(context: CallContext, ref: SlideRef): Promise<NotesPageExport> {
	const deck = context.session.deck
	const parts = viewParts(deck)

	if (!deck.slides.includes(ref) || parts === undefined) throw new PresentationError("notFound", "slide")

	const node = deck.nodes.get(ref) ?? (await parts.slide(ref, context.slicing))
	const width = Math.max(1, deck.notesSize.cx / EMU_PER_PX)
	const height = Math.max(1, deck.notesSize.cy / EMU_PER_PX)
	const masterRef = deck.notesMaster
	const master = masterRef === undefined ? undefined : (deck.nodes.get(masterRef) ?? (await parts.slide(masterRef, context.slicing)))
	const notesRef = node.notes
	const target = notesRef ?? masterRef

	if (target === undefined) {
		const empty: SlideRender = {
			ref,
			index: -1,
			revision: 0,
			hidden: false,
			background: emptyDrawing(width, height),
			layers: [],
			notesText: "",
			animated: false
		}

		return { page: { render: empty, kinds: [] }, width, height, slideBox: defaultNotesSlideBox({ width, height }), slideAfter: 0 }
	}

	const rendered = await renderNodeFor(context, target)
	const notesNode = deck.nodes.get(target)
	// A master drawn on its own shows its placeholders (prompt text, the date, number 1): only its art is kept.
	const render: SlideRender =
		notesRef === undefined
			? {
					...rendered,
					layers: rendered.layers.filter(
						layer => layer.shape.slide !== target || findShape(notesNode?.shapes ?? [], layer.shape.id)?.shape.ph === undefined
					)
				}
			: rendered
	const own = notesRef === undefined ? undefined : sldImgOf(notesNode)
	const slideBox = boxOf(own) ?? boxOf(sldImgOf(master)) ?? defaultNotesSlideBox({ width, height })
	const at = own === undefined ? -1 : render.layers.findIndex(layer => layer.shape.slide === target && layer.shape.id === own.id)

	return {
		page: { render, kinds: layerKinds(notesNode, render) },
		width,
		height,
		slideBox,
		slideAfter: at < 0 ? render.layers.length : at + 1
	}
}

// Faces as sent: their bytes copied (the session's font assets keep their own).
async function facesOf(session: EngineSession): Promise<DocxFontFace[]> {
	return (await sessionFaces(session)).map(face => (face.kind === "bytes" ? { ...face, bytes: face.bytes.slice() } : face))
}

// A password the PDF security handler cannot take (SASLprep prohibits it) refuses as unsupported, naming the password,
// so the page tells the user that, not that the export failed.
async function pdfSecurity(session: EngineSession): Promise<PdfSecurityKey | undefined> {
	const password = pptPassword(session.deck) ?? pptxPassword(session.deck)

	try {
		return password === undefined ? undefined : await standardSecurityKey(password)
	} catch (error) {
		if (error instanceof PdfWriteError && error.reason === "password")
			throw new PresentationError("unsupported", `password: ${error.message}`)

		throw error
	}
}

function refs(value: unknown): readonly SlideRef[] {
	return Array.isArray(value) ? (value.filter(ref => typeof ref === "number") as SlideRef[]) : []
}

async function answer(context: CallContext, method: JobPortMethod, args: readonly unknown[]): Promise<unknown> {
	const session = context.session

	switch (method) {
		case "render": {
			const out: SlideRender[] = []

			for (const ref of refs(args[0])) out.push(await renderSlideFor(context, ref))

			return out
		}
		case "exportSlides": {
			const out: SlideExport[] = []

			for (const ref of refs(args[0])) out.push(exportOf(session, await renderSlideFor(context, ref)))

			return out
		}
		case "notesPage":
			return notesPage(context, args[0] as SlideRef)
		case "media":
			return mediaCapability.media(context, String(args[0]), args[1] as PortLike)
		case "freshParts":
			return convertCapability.freshParts(context, args[0] === "odp" ? "odp" : "pptx", args[1] as PortLike)
		case "image": {
			const found = await readImage(session, String(args[0]))

			// Copied: the package's reads may be views of what it keeps.
			return found === null ? null : { bytes: found.bytes.slice(), type: found.type }
		}
		case "deckInfo":
			return deckInfo(session)
		case "faces":
			return facesOf(session)
		case "pdfSecurity":
			return pdfSecurity(session)
	}
}

// What an answer transfers: its arrays' buffers, never an empty one (renders may share an empty array constant, which a
// transfer would detach for every later render).
function transferables(value: unknown): unknown[] {
	return presentationTransferables(value).filter(item => !(item instanceof ArrayBuffer) || item.byteLength > 0)
}

function refusalOf(error: unknown): { reason: PresentationRefusal; message: string } {
	if (error instanceof PresentationError) return { reason: error.reason, message: error.message }

	return { reason: "failed", message: error instanceof Error ? error.message : String(error) }
}

// Serves `port` for the session until "close" or the session's end.
export function serveJobsPort(context: CallContext, port: JobsPortEnd): void {
	const session = context.session
	let closed = false
	const listeners: (() => void)[] = []
	const signal: CallSignal = {
		get aborted() {
			return closed
		},
		onAbort: listener => {
			listeners.push(listener)
		}
	}
	const call: CallContext = { session, signal, lane: "background", slicing: context.slicing }
	const onMessage = (event: { readonly data: unknown }): void => {
		const message = event.data as ToJobsPort | null | undefined

		if (typeof message !== "object" || message === null) return

		if (message.t === "close") {
			close()

			return
		}

		if (message.t !== "call" || typeof message.id !== "number") return

		const id = message.id

		void answer(call, message.method, Array.isArray(message.args) ? message.args : []).then(
			value => {
				if (closed) return

				const reply: FromJobsPort = { t: "result", id, value }

				try {
					port.postMessage(reply, transferables(value))
				} catch (error) {
					port.postMessage({ t: "refused", id, ...refusalOf(error) } satisfies FromJobsPort)
				}
			},
			(error: unknown) => {
				if (closed) return

				const reply: FromJobsPort = { t: "refused", id, ...refusalOf(error) }

				port.postMessage(reply)
			}
		)
	}
	const close = (): void => {
		if (closed) return

		closed = true
		port.removeEventListener("message", onMessage)
		port.close()

		for (const listener of listeners.splice(0)) listener()
	}

	port.addEventListener("message", onMessage)
	port.start?.()
	session.onClose(close)
}

export const jobsCapability: JobsCapability = {
	jobsPort: (context, port) => {
		if (!isJobsPortEnd(port)) return Promise.reject(new PresentationError("unsupported", "jobsPort needs a MessagePort"))

		serveJobsPort(context, port)

		return Promise.resolve()
	}
}
