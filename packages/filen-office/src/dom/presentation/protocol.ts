import type { CompiledTimegraph } from "../../core/anim/model"
import type { DeckOp, SmartArtDefRef } from "../../core/presentation/edit/ops"
import type {
	CustomShow,
	DeckVariant,
	Format,
	GateReason,
	PresentationRefusal,
	Section,
	ShapeRef,
	SlideRef,
	TextBody
} from "../../core/presentation/model"
import type { SlideRender, TextPage, TextSeed, TransferableTextLayout } from "../../core/presentation/output"
import type { DocxFontFace } from "../docx/protocol"

export type {
	ActionSummary,
	LayerRole,
	RenderEffect,
	RenderEffects,
	SlideLayer,
	SlideRender,
	TextPage,
	TextSeed,
	TransferableTextLayout
} from "../../core/presentation/output"

// What a page and a presentation worker say to each other. Everything is plain data that crosses the boundary by
// structured clone. What is transferred is decided per message (transferablesOf): output arrays (drawing and text
// data, find results), inserted bytes, ports and bitmaps; model values (bodies, shapes, ink, timing) are cloned, so
// neither side's live model or retained values are ever detached. `s` names the open (one deck,
// then its session); `id` names a call on it; answers and events for one open come in the order the worker made
// them. Ports and bitmaps are typed structurally (the module builds without the DOM library).

// A MessagePort as the protocol uses it.
export interface PortLike {
	postMessage(message: unknown, transfer?: readonly unknown[]): void
	start?(): void
	close(): void
}

// An ImageBitmap (transferred; whoever holds it last closes it).
export interface BitmapLike {
	readonly width: number
	readonly height: number
	close(): void
}

// The deck's bytes: in memory (archive entries, encrypted packages, ≤ 256 MiB), or a range port to the SDK worker
// (`checked`: it serves readChecked, CRC computed where the bytes live).
export type SourceSpec =
	| { readonly kind: "bytes"; readonly bytes: Uint8Array }
	| { readonly kind: "range"; readonly port: PortLike; readonly size: number; readonly checked: boolean }

export interface OpenInfo {
	readonly format: Format
	readonly variant: DeckVariant
	// Every slide in order, parsed or not (the rail, render and thumbnails name slides by ref).
	readonly slides: readonly { readonly ref: SlideRef; readonly hidden: boolean }[]
	// EMU.
	readonly size: { readonly cx: number; readonly cy: number; readonly type?: string }
	readonly notesSize: { readonly cx: number; readonly cy: number }
	readonly sections: readonly Section[]
	readonly customShows: readonly CustomShow[]
	readonly protection: { readonly writeProtected: boolean; readonly encrypted: boolean }
	readonly gate: readonly GateReason[]
	readonly editable: boolean
	// Shapes locked from editing (LockReason on the shape), as counted so far.
	readonly locks: number
	readonly packageBytes: number
	readonly source: "bytes" | "range"
}

// Typed notices: none is ever an untyped string for the user.
export type PresentationNotice =
	| { readonly kind: "gate"; readonly reason: GateReason }
	| {
			readonly kind: "lock"
			readonly shape: ShapeRef
			readonly reason: "proofFailed" | "alternateContent" | "unknownFrame" | "gate" | "budget"
	  }
	| { readonly kind: "linkedFile"; readonly shape?: ShapeRef; readonly target: string }
	| { readonly kind: "refusedAction"; readonly shape: ShapeRef; readonly what: string }
	| { readonly kind: "macros" }
	| {
			readonly kind: "media"
			readonly part: string
			readonly reason: "unplayable" | "preparing" | "notMedia" | "tooLarge"
			readonly progress?: number
	  }
	| { readonly kind: "autosaveOff"; readonly reason: "large" | "encrypted" }
	| { readonly kind: "fontScale"; readonly shape: ShapeRef }
	| { readonly kind: "saveReverted"; readonly ops: number }
	| { readonly kind: "budget"; readonly what: string }
	// Jumps to deleted slides now go to the next slide; `count` of them, in `shapes`.
	| { readonly kind: "jumpsRewritten"; readonly count: number; readonly shapes: readonly ShapeRef[] }

export type PresentationEvent =
	| { readonly type: "opened"; readonly info: OpenInfo }
	| { readonly type: "fonts"; readonly faces: readonly DocxFontFace[] }
	// In order, window-first.
	| { readonly type: "slides"; readonly renders: readonly SlideRender[]; readonly final: boolean }
	// Transferred.
	| {
			readonly type: "thumbs"
			readonly items: readonly { readonly slide: SlideRef; readonly revision: number; readonly bitmap: BitmapLike }[]
	  }
	// slides: the slides whose renders changed; info.slides after slide ops. dirty: the current history node is not the
	// saved one (the dirty indicator).
	| {
			readonly type: "changed"
			readonly revision: number
			readonly dirty: boolean
			// Net bytes dirty against the saved state as the history estimates them (the autosave tiers' 1 KiB rule).
			readonly dirtyBytes?: number
			readonly slides: readonly SlideRef[]
			readonly info?: Partial<OpenInfo>
	  }
	| { readonly type: "saveProgress"; readonly sent: number; readonly total?: number }
	| { readonly type: "notice"; readonly notice: PresentationNotice }
	| { readonly type: "error"; readonly reason: PresentationRefusal; readonly message: string }

// seed: the body open in the text editor view, laid out again, when the step touched it (the view reseeds from it).
export type CommandResult =
	| { readonly ok: true; readonly revision: number; readonly dirty: boolean; readonly seed?: TextSeed }
	| { readonly ok: false; readonly refusal: PresentationRefusal }

export interface FindOptions {
	readonly caseSensitive?: boolean
	readonly wholeWord?: boolean
	// Slides, notes, tables and SmartArt text (default all).
	readonly scope?: readonly ("slides" | "notes" | "tables" | "smartart")[]
	// Stops after this many matches and one more (default PRESENTATION_FIND_LIMIT).
	readonly limit?: number
}

export const PRESENTATION_FIND_LIMIT = 10_000

// Per match: slide index, shape id, paragraph, start, end, flags (FIND_IN_*).
export const PRESENTATION_FIND_INTS = 6
export const FIND_IN_NOTES = 1
export const FIND_IN_TABLE = 2
export const FIND_IN_SMARTART = 4

// A media stream registered on the port: its size and type, and whether ranges can be served.
export interface PortStreamMeta {
	readonly size: number
	readonly contentType: string
	readonly seekable: boolean
}

export type MediaRefusal = {
	readonly kind: "refused"
	readonly reason: "notFound" | "linked" | "notMedia" | "preparing" | "tooLarge" | "notImplemented"
}

// What the show asks layers for: per step, the shapes it animates and how (bitmap, or the DOM layer).
export interface LayerPlan {
	readonly shapes: readonly number[]
	// Per shape of `shapes`, its text sub-ranges built on their own.
	readonly ranges?: readonly (readonly { readonly target: "para" | "char"; readonly range: readonly [number, number] }[] | undefined)[]
	readonly dpr: number
}

// A layer bitmap cropped to its shape's bounds plus effect extents (slide px), transferred.
export interface ShowLayer {
	readonly shape: number
	readonly range?: { readonly target: "para" | "char"; readonly range: readonly [number, number] }
	readonly bitmap: BitmapLike
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

export type SaveResult =
	| { readonly kind: "unchanged" }
	| {
			readonly kind: "written"
			readonly bytes: number
			readonly revision: number
			readonly notices: readonly PresentationNotice[]
			// Network bytes of the save: the package uploaded, and the copies a range-backed deck downloaded for it.
			readonly transfer?: { readonly uploaded: number; readonly downloaded: number }
	  }
	| { readonly kind: "refused"; readonly reason: PresentationRefusal }

// The drive file a save produced (the upload rotates the uuid).
export interface DriveFileRef {
	readonly uuid: string
	readonly name: string
}

export interface ConversionReport {
	readonly target: "pptx" | "odp"
	readonly bytes: number
	// Losses by kind, with counts.
	readonly losses: readonly { readonly kind: string; readonly count: number; readonly slides?: readonly number[] }[]
}

export interface PresentationSessionApi {
	render(refs: readonly SlideRef[], options?: { readonly scale?: number }): Promise<readonly SlideRender[]>
	// Answers through "thumbs" events.
	thumbnails(refs: readonly SlideRef[], widthPx: number): Promise<void>
	textSeed(shape: ShapeRef): Promise<TextSeed>
	layoutText(
		shape: ShapeRef,
		body: TextBody,
		caretHint?: number
	): Promise<{ readonly page: TextPage; readonly layout: TransferableTextLayout; readonly revision: number }>
	command(op: DeckOp): Promise<CommandResult>
	// `open`: the body open in the text editor view, reseeded in the answer when the step touches it.
	undo(open?: ShapeRef): Promise<CommandResult>
	redo(open?: ShapeRef): Promise<CommandResult>
	// PRESENTATION_FIND_INTS per match.
	find(query: string, options?: FindOptions): Promise<Int32Array>
	media(part: string, port: PortLike): Promise<PortStreamMeta | MediaRefusal>
	// A picture's bytes for the SVG painter (a part name, or "inserted:<id>" for an image an op inserted); null when
	// the package has none.
	image(part: string): Promise<{ readonly bytes: Uint8Array; readonly type: string } | null>
	// A SmartArt layout (with a style and colours) laid out over sample text, for the gallery and the switch-layout
	// previews.
	smartArtPreview(
		layout: SmartArtDefRef,
		options: {
			readonly style?: SmartArtDefRef
			readonly colors?: SmartArtDefRef
			readonly widthPx: number
			readonly sample?: readonly string[]
		}
	): Promise<BitmapLike>
	timegraph(slide: SlideRef): Promise<CompiledTimegraph>
	layers(slide: SlideRef, widthPx: number, plan: LayerPlan): Promise<readonly ShowLayer[]>
	// Writes to the save port (pull protocol, ≤ 1 MiB chunks, ≤ 4 in flight).
	save(options: { readonly reason: "user" | "auto"; readonly port: PortLike }): Promise<SaveResult>
	// revision: the SaveResult's; answers whether edits made during the save keep the deck dirty.
	commitSaved(options: {
		readonly file: DriveFileRef
		readonly port: PortLike
		readonly size: number
		readonly revision: number
	}): Promise<{ readonly dirty: boolean }>
	// Serves a jobs worker on `port` (exports and conversions read the unsaved session through it).
	jobsPort(port: PortLike): Promise<void>
	// Streams a fresh package of the session's state to `port`.
	freshParts(target: "pptx" | "odp", port: PortLike): Promise<ConversionReport>
	// Drops the session's password and caches.
	close(): void
}

export type PresentationMethod = Exclude<keyof PresentationSessionApi, "close">

export const PRESENTATION_METHODS: readonly PresentationMethod[] = [
	"render",
	"thumbnails",
	"textSeed",
	"layoutText",
	"command",
	"undo",
	"redo",
	"find",
	"media",
	"image",
	"smartArtPreview",
	"timegraph",
	"layers",
	"save",
	"commitSaved",
	"jobsPort",
	"freshParts"
]

export type PresentationArgs<M extends PresentationMethod> = Parameters<PresentationSessionApi[M]>

export type PresentationValue<M extends PresentationMethod> = Awaited<ReturnType<PresentationSessionApi[M]>>

export interface PresentationOpenOptions {
	readonly format: Format
	readonly fileName: string
	// Slides rendered first (the window around the slide the page shows), then the rest in order.
	readonly window?: { readonly from: number; readonly count: number }
	readonly viewOnly?: boolean
}

export type PresentationCall = {
	readonly [M in PresentationMethod]: {
		readonly t: "call"
		readonly s: number
		readonly id: number
		readonly method: M
		readonly args: PresentationArgs<M>
	}
}[PresentationMethod]

export type ToPresentationWorker =
	| { readonly t: "open"; readonly s: number; readonly source: SourceSpec; readonly options: PresentationOpenOptions }
	| { readonly t: "abortOpen"; readonly s: number }
	// The password of an encrypted deck (answered by "opened" or an "error" event with wrongPassword); it stays in
	// the worker's session.
	| { readonly t: "unlock"; readonly s: number; readonly password: string }
	| PresentationCall
	| { readonly t: "abort"; readonly s: number; readonly id: number }
	| { readonly t: "dispose"; readonly s: number }

export type PresentationResult = {
	readonly [M in PresentationMethod]: {
		readonly t: "result"
		readonly s: number
		readonly id: number
		readonly method: M
		readonly value: PresentationValue<M>
	}
}[PresentationMethod]

export type FromPresentationWorker =
	| { readonly t: "event"; readonly s: number; readonly event: PresentationEvent }
	| PresentationResult
	| { readonly t: "refused"; readonly s: number; readonly id: number; readonly reason: PresentationRefusal; readonly message: string }

// What posting `message` transfers, by message, method and event: never a model value (see the header).
export function transferablesOf(message: ToPresentationWorker | FromPresentationWorker): unknown[] {
	const into = new Set<unknown>()

	switch (message.t) {
		case "open":
			if (message.source.kind === "bytes") addView(message.source.bytes, into)
			else addPort(message.source.port, into)
			break
		case "call":
			callTransferables(message, into)
			break
		case "result":
			resultTransferables(message, into)
			break
		case "event":
			if (message.event.type === "slides") for (const render of message.event.renders) renderTransferables(render, into)
			else if (message.event.type === "thumbs") for (const item of message.event.items) addBitmap(item.bitmap, into)
			break
		default:
			break
	}

	return [...into]
}

function callTransferables(call: PresentationCall, into: Set<unknown>): void {
	switch (call.method) {
		case "media":
			addPort(call.args[1], into)
			return
		case "save":
		case "commitSaved":
			addPort(call.args[0].port, into)
			return
		case "jobsPort":
			addPort(call.args[0], into)
			return
		case "freshParts":
			addPort(call.args[1], into)
			return
		case "command": {
			const op = call.args[0]

			if (op.family === "picture" && (op.kind === "insert" || op.kind === "replace")) addView(op.image.bytes, into)
			else if (op.family === "media" && op.kind === "insert" && op.media.poster !== undefined) addView(op.media.poster.bytes, into)
			else if (op.family === "media" && op.kind === "setPoster") addView(op.poster.bytes, into)
			else if (op.family === "chart" && op.kind === "setWorkbook") addView(op.workbook, into)

			return
		}
		default:
			return
	}
}

function resultTransferables(result: PresentationResult, into: Set<unknown>): void {
	switch (result.method) {
		case "render":
			for (const render of result.value) renderTransferables(render, into)
			return
		case "textSeed":
		case "layoutText":
			presentationTransferables(result.value.page, into)
			presentationTransferables(result.value.layout, into)
			return
		case "command":
		case "undo":
		case "redo":
			if (result.value.ok && result.value.seed !== undefined) {
				presentationTransferables(result.value.seed.page, into)
				presentationTransferables(result.value.seed.layout, into)
			}

			return
		case "find":
			addView(result.value, into)
			return
		case "image":
			if (result.value !== null) addView(result.value.bytes, into)
			return
		case "layers":
			for (const layer of result.value) addBitmap(layer.bitmap, into)
			return
		case "smartArtPreview":
			addBitmap(result.value, into)
			return
		default:
			return
	}
}

// A render's drawing and text data (made for this message, so the worker gives it up).
function renderTransferables(render: SlideRender, into: Set<unknown>): void {
	presentationTransferables(render.background, into)

	for (const layer of render.layers) {
		presentationTransferables(layer.drawing, into)

		if (layer.text !== undefined) presentationTransferables(layer.text, into)
	}
}

function addView(view: ArrayBufferView, into: Set<unknown>): void {
	const buffer = view.buffer

	// Only a view owning its whole buffer: transferring a shared buffer would detach its other views.
	if (buffer instanceof ArrayBuffer && buffer.byteLength === view.byteLength) into.add(buffer)
}

function addPort(port: PortLike, into: Set<unknown>): void {
	if (PORT === undefined || port instanceof PORT) into.add(port)
}

function addBitmap(bitmap: BitmapLike, into: Set<unknown>): void {
	if (BITMAP !== undefined && bitmap instanceof BITMAP) into.add(bitmap)
}

// The output arrays of an output subtree (drawing data, a text page or layout): the buffers of its typed arrays
// (each owns its whole buffer), its ports and its bitmaps, walking plain objects and arrays at most MAX_DEPTH levels
// down. Only for values made for the message.
export function presentationTransferables(value: unknown, into: Set<unknown> = new Set(), depth = 0): unknown[] {
	collect(value, into, depth)

	return [...into]
}

function constructorOf(name: string): (abstract new (...args: never[]) => unknown) | undefined {
	const found: unknown = Reflect.get(globalThis, name)

	return typeof found === "function" ? (found as abstract new (...args: never[]) => unknown) : undefined
}

const PORT = constructorOf("MessagePort")
const BITMAP = constructorOf("ImageBitmap")
const MAX_DEPTH = 12

function collect(value: unknown, into: Set<unknown>, depth: number): void {
	if (depth > MAX_DEPTH || typeof value !== "object" || value === null) return

	if (ArrayBuffer.isView(value)) {
		const buffer = value.buffer

		if (buffer instanceof ArrayBuffer && buffer.byteLength === value.byteLength) into.add(buffer)

		return
	}

	if ((PORT !== undefined && value instanceof PORT) || (BITMAP !== undefined && value instanceof BITMAP)) {
		into.add(value)

		return
	}

	if (Array.isArray(value)) {
		for (const item of value) collect(item, into, depth + 1)

		return
	}

	if (value instanceof Map || value instanceof Set || value instanceof ArrayBuffer) return

	for (const item of Object.values(value)) collect(item, into, depth + 1)
}
