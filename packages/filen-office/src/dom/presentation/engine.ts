import { bytesSource, type ByteSource, type OpcPackage, type Slicing, type ZipArchive } from "../../core/opc/index"
import type { SmartArtDefRef } from "../../core/presentation/edit/ops"
import type { SmartArtInfo } from "../../core/smartart/edit"
import {
	PresentationError,
	type Deck,
	type DeckVariant,
	type Format,
	type Refused,
	type ShapeNode,
	type ShapeRef
} from "../../core/presentation/model"
import type { DocxFontFace } from "../docx/protocol"
import { macrotaskYield } from "../docx/host"
import {
	transferablesOf,
	type BitmapLike,
	type FromPresentationWorker,
	type OpenInfo,
	type PortLike,
	type PresentationArgs,
	type PresentationEvent,
	type PresentationMethod,
	type PresentationOpenOptions,
	type PresentationValue,
	type SourceSpec,
	type ToPresentationWorker
} from "./protocol"
import { convertCapability } from "./engine/convert"
import { editCapability } from "./engine/edit"
import { findCapability } from "./engine/find"
import { fontsCapability } from "./engine/fonts"
import { jobsCapability } from "./engine/jobs"
import { mediaCapability } from "./engine/media"
import { openOdpCapability } from "./engine/open/odp"
import { openPptCapability } from "./engine/open/ppt"
import { openPptxCapability } from "./engine/open/pptx"
import { saveCapability } from "./engine/save"
import { showCapability } from "./engine/show"
import { smartartCapability } from "./engine/smartart"
import { textCapability, type TextServices } from "./engine/text"
import { thumbsCapability } from "./engine/thumbs"
import { viewCapability } from "./engine/view"
import { rebasableSource } from "./save"
import { streamOpenWindow } from "./window"

// The presentation worker's engine: a registry of capabilities, each in its own file under engine/ with one owner,
// and the dispatcher that serves the protocol over them. A session is one open deck; every call on it goes to the
// capability that owns its method. The worker host (host.ts) adds pooling, the scheduler and the range sources.
//
// Capabilities read `session.package` per call and never keep it: a save's rebase replaces it. Work yields through
// its Slicing; after every pause() a task re-checks the revisions it read (slide, deck, theme) and restarts or answers
// stale. A save snapshot never yields across a command: commands queue until it ends.

// The package a session opened, as the capabilities that write or serve it need it.
export interface OpenedPackage {
	readonly format: Format
	readonly variant: DeckVariant
	readonly bytes: number
	readonly source: ByteSource
	readonly sourceKind: SourceSpec["kind"]
	readonly archive?: ZipArchive
	// The OPC package (pptx, and ppt through its in-memory pptx).
	readonly opc?: OpcPackage
	// Shapes locked at open.
	readonly locks: number
	// Called once when the session closes (drops what the opener kept: a decrypted package's key).
	readonly release?: () => void
	// A format the session only shows (ppt): edits and saves are refused viewOnly, as for the viewOnly open option.
	readonly viewOnly?: boolean
}

// Which lane a call runs in: the priority lane is served before the next background slice (§ scheduler).
export type Lane = "priority" | "background"

export const PRESENTATION_LANES: { readonly [M in PresentationMethod]: Lane } = {
	render: "priority",
	thumbnails: "background",
	textSeed: "priority",
	layoutText: "priority",
	command: "priority",
	undo: "priority",
	redo: "priority",
	find: "background",
	media: "background",
	registerMedia: "background",
	image: "background",
	smartArtPreview: "background",
	smartArtInfo: "priority",
	timegraph: "background",
	layers: "background",
	save: "background",
	commitSaved: "background",
	jobsPort: "background",
	freshParts: "background"
}

export interface CallSignal {
	readonly aborted: boolean
	onAbort(listener: () => void): void
}

export type Task = (slicing: Slicing, signal: CallSignal) => Promise<void>

// The worker's scheduler: slices of at most 8 ms, the priority lane first (host.ts implements it).
export interface PresentationScheduler {
	// The Slicing of work in `lane`: pause() yields to queued priority work first.
	slicing(lane: Lane): Slicing
	// Background work not tied to a call (thumbnails ahead, proofs, the inflate index…).
	schedule(lane: Lane, task: Task, signal: CallSignal): void
}

// Serves one medium's bytes on the port the page handed to media(): the web's range-port protocol
// (lib/media/rangePort.ts exposeRangePort). `read` answers [start, end) of the medium; `closed` ends serving.
export interface MediaPortServer {
	serve(port: PortLike, read: (start: number, end: number, signal: CallSignal) => Promise<Uint8Array>, closed: CallSignal): void
}

export interface EngineServices {
	readonly fonts: FontsCapability
	readonly smartart: SmartArtCapability
	// Serves media() on the page's port; absent: media() is refused notImplemented.
	readonly media?: MediaPortServer
	// A shape's text chain, box and measuring environment (layoutText); absent: layoutText is refused notImplemented.
	readonly text?: TextServices
}

export interface EngineSession {
	readonly s: number
	readonly deck: Deck
	// Replaced by a save's rebase (commitSaved): read it per call, never keep it.
	package: OpenedPackage
	readonly options: PresentationOpenOptions
	readonly services: EngineServices
	// A ByteSource over a range port (the rebase opens the saved file's port through it); undefined when the host
	// serves no range sources.
	readonly rangeSource: ((spec: Extract<SourceSpec, { kind: "range" }>) => ByteSource) | undefined
	schedule(lane: Lane, task: Task): void
	// Sends an event for this session (its typed arrays, ports and bitmaps transferred).
	emit(event: PresentationEvent): void
	// Called once when the session closes (a capability drops its caches and secrets here).
	onClose(listener: () => void): void
}

export interface CallContext {
	readonly session: EngineSession
	readonly signal: CallSignal
	readonly lane: Lane
	readonly slicing: Slicing
}

export type MethodHandler<M extends PresentationMethod> = (
	context: CallContext,
	...args: PresentationArgs<M>
) => Promise<PresentationValue<M>>

export type Capability<M extends PresentationMethod> = { readonly [K in M]: MethodHandler<K> }

export type ViewCapability = Capability<"render" | "image">
export type ThumbsCapability = Capability<"thumbnails">
export type TextCapability = Capability<"textSeed" | "layoutText">
export type EditCapability = Capability<"command" | "undo" | "redo">
export type SaveCapability = Capability<"save" | "commitSaved">
export type MediaCapability = Capability<"media" | "registerMedia">
export type ShowCapability = Capability<"timegraph" | "layers">
export type FindCapability = Capability<"find">
export type JobsCapability = Capability<"jobsPort">
export type ConvertCapability = Capability<"freshParts">

// The faces the deck's text is measured and drawn with (bundled substitutes and decoded embedded fonts).
export interface FontsCapability {
	faces(session: EngineSession): Promise<readonly DocxFontFace[]>
}

// The SmartArt engine: the renderer and the editor reach a diagram's relayout through it, and the gallery its
// previews (the protocol's smartArtPreview).
export interface SmartArtCapability extends Capability<"smartArtPreview" | "smartArtInfo"> {
	relayout(
		session: EngineSession,
		target: ShapeRef,
		slicing: Slicing
	): Promise<{ readonly shapes: readonly ShapeNode[]; readonly drawingXml: string }>
	preview(
		session: EngineSession,
		layout: SmartArtDefRef,
		options: {
			readonly style?: SmartArtDefRef
			readonly colors?: SmartArtDefRef
			readonly widthPx: number
			readonly sample?: readonly string[]
		},
		slicing: Slicing
	): Promise<BitmapLike>
	// The text pane's outline of a diagram and the definitions the deck embeds.
	info(session: EngineSession, target: ShapeRef): Promise<SmartArtInfo>
}

export interface OpenRequest {
	readonly source: ByteSource
	readonly sourceKind: SourceSpec["kind"]
	readonly options: PresentationOpenOptions
	readonly password?: string
}

export type OpenOutcome =
	{ readonly kind: "opened"; readonly deck: Deck; readonly package: OpenedPackage } | { readonly kind: "needsPassword" } | Refused

export interface OpenCapability {
	open(request: OpenRequest): Promise<OpenOutcome>
}

export const CAPABILITIES = {
	view: viewCapability,
	thumbs: thumbsCapability,
	text: textCapability,
	edit: editCapability,
	save: saveCapability,
	media: mediaCapability,
	show: showCapability,
	find: findCapability,
	jobs: jobsCapability,
	convert: convertCapability
} as const

export const SERVICES: EngineServices = { fonts: fontsCapability, smartart: smartartCapability }

export const OPENERS: { readonly [F in Format]: OpenCapability } = {
	pptx: openPptxCapability,
	odp: openOdpCapability,
	ppt: openPptCapability
}

type Handlers = { readonly [M in PresentationMethod]: MethodHandler<M> }

export const METHOD_HANDLERS: Handlers = {
	...CAPABILITIES.view,
	...CAPABILITIES.thumbs,
	...CAPABILITIES.text,
	...CAPABILITIES.edit,
	...CAPABILITIES.save,
	...CAPABILITIES.media,
	...CAPABILITIES.show,
	...CAPABILITIES.find,
	...CAPABILITIES.jobs,
	...CAPABILITIES.convert,
	smartArtPreview: (context, ...args) => context.session.services.smartart.smartArtPreview(context, ...args),
	smartArtInfo: (context, ...args) => context.session.services.smartart.smartArtInfo(context, ...args)
}

// What the methods that edit or save the deck in place answer in a view-only session (Save as a copy still works):
// their own typed refusal, as for a gated deck.
const VIEW_ONLY_ANSWERS: { readonly [M in PresentationMethod]?: PresentationValue<M> } = {
	command: { ok: false, refusal: "viewOnly" },
	undo: { ok: false, refusal: "viewOnly" },
	redo: { ok: false, refusal: "viewOnly" },
	save: { kind: "refused", reason: "viewOnly" }
}

function isViewOnly(opened: OpenedPackage, options: PresentationOpenOptions): boolean {
	return opened.viewOnly === true || options.viewOnly === true
}

export function openInfo(deck: Deck, opened: OpenedPackage, viewOnly = opened.viewOnly === true): OpenInfo {
	return {
		format: deck.format,
		variant: deck.variant,
		slides: deck.slides.map(ref => ({ ref, hidden: deck.nodes.get(ref)?.hidden ?? deck.hiddenSlides?.has(ref) ?? false })),
		layouts: deck.layouts.flatMap(ref => {
			const node = deck.nodes.get(ref)

			return node === undefined || node.parent === undefined
				? []
				: [
						{
							ref,
							master: node.parent,
							...(node.layoutType === undefined ? {} : { type: node.layoutType }),
							...(node.name === undefined ? {} : { name: node.name })
						}
					]
		}),
		size: { ...deck.size },
		notesSize: { ...deck.notesSize },
		sections: deck.sections,
		customShows: deck.customShows,
		protection: { writeProtected: deck.protection.modifyVerifier !== undefined, encrypted: deck.protection.encrypted !== undefined },
		gate: deck.gate,
		editable: deck.gate.length === 0 && !viewOnly,
		locks: opened.locks,
		packageBytes: opened.bytes,
		source: opened.sourceKind,
		show: deck.show
	}
}

// The worker's side of a message channel (a worker's `self`, a MessagePort, or an in-thread loopback).
export interface PresentationEndpoint {
	postMessage(message: FromPresentationWorker, transfer: unknown[]): void
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
	removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
}

export interface ServeOptions {
	// A ByteSource over a range port (the host's block cache); without one, range sources are refused.
	readonly rangeSource?: (spec: Extract<SourceSpec, { kind: "range" }>) => ByteSource
	readonly openers?: { readonly [F in Format]?: OpenCapability }
	readonly handlers?: Partial<Handlers>
	readonly services?: Partial<EngineServices>
	// The host's scheduler; without one, every call runs at once and pauses take a macrotask after 8 ms.
	readonly scheduler?: PresentationScheduler
}

const SLICE_MS = 8

// Pauses after 8 ms, lanes not told apart (the in-thread default; the worker host brings the real scheduler).
function directScheduler(): PresentationScheduler {
	const turn = macrotaskYield()
	const now: () => number = () => Date.now()
	const slicing: Slicing = { pause: turn, sliceMs: SLICE_MS, now }

	return {
		slicing: () => slicing,
		schedule: (_lane, task, signal) => {
			void task(slicing, signal).catch(() => undefined)
		}
	}
}

interface PendingOpen {
	readonly request: OpenRequest
	aborted: boolean
}

interface LiveSession {
	readonly session: EngineSession
	readonly calls: Map<number, { aborted: boolean; readonly listeners: (() => void)[] }>
	readonly closers: (() => void)[]
	readonly viewOnly: boolean
}

function isMessage(data: unknown): data is ToPresentationWorker {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as { t?: unknown }).t === "string" &&
		typeof (data as { s?: unknown }).s === "number"
	)
}

// Serves the protocol on `endpoint` until the returned function stops it (which closes every session).
export function servePresentation(endpoint: PresentationEndpoint, options: ServeOptions = {}): () => void {
	const handlers: Handlers = { ...METHOD_HANDLERS, ...options.handlers }
	const services: EngineServices = { ...SERVICES, ...options.services }
	const scheduler = options.scheduler ?? directScheduler()
	const pending = new Map<number, PendingOpen>()
	const sessions = new Map<number, LiveSession>()

	const post = (message: FromPresentationWorker): void => {
		endpoint.postMessage(message, transferablesOf(message))
	}

	const fail = (s: number, error: unknown, fallback: "failed" | "aborted" = "failed"): void => {
		const reason = error instanceof PresentationError ? error.reason : fallback

		post({ t: "event", s, event: { type: "error", reason, message: error instanceof Error ? error.message : String(error) } })
	}

	const close = (s: number): void => {
		const live = sessions.get(s)

		pending.delete(s)

		if (live === undefined) return

		sessions.delete(s)

		for (const call of live.calls.values()) {
			call.aborted = true

			for (const listener of call.listeners) listener()
		}

		for (const closer of live.closers) closer()
	}

	const open = async (s: number, request: OpenRequest): Promise<void> => {
		const entry: PendingOpen = { request, aborted: false }

		pending.set(s, entry)

		const opener = options.openers?.[request.options.format] ?? OPENERS[request.options.format]
		let outcome: OpenOutcome

		try {
			outcome = await opener.open(request)
		} catch (error) {
			if (pending.get(s) === entry) pending.delete(s)

			if (!entry.aborted) fail(s, error)

			return
		}

		if (entry.aborted || pending.get(s) !== entry) {
			if (outcome.kind === "opened") outcome.package.release?.()

			return
		}

		if (outcome.kind === "needsPassword") {
			post({
				t: "event",
				s,
				event: { type: "error", reason: request.password === undefined ? "needsPassword" : "wrongPassword", message: "" }
			})

			return
		}

		pending.delete(s)

		if (outcome.kind === "refused") {
			post({ t: "event", s, event: { type: "error", reason: outcome.reason, message: outcome.detail ?? "" } })

			return
		}

		const closers: (() => void)[] = []

		if (outcome.package.release !== undefined) closers.push(outcome.package.release)
		const closed = { aborted: false, listeners: [] as (() => void)[] }
		const sessionSignal: CallSignal = {
			get aborted() {
				return closed.aborted
			},
			onAbort: listener => {
				closed.listeners.push(listener)
			}
		}

		closers.push(() => {
			closed.aborted = true

			for (const listener of closed.listeners) listener()
		})

		const session: EngineSession = {
			s,
			deck: outcome.deck,
			package: outcome.package,
			options: request.options,
			services,
			rangeSource: options.rangeSource,
			schedule: (lane, task) => {
				scheduler.schedule(lane, task, sessionSignal)
			},
			emit: event => {
				if (sessions.has(s)) post({ t: "event", s, event })
			},
			onClose: listener => {
				closers.push(listener)
			}
		}

		const viewOnly = isViewOnly(outcome.package, request.options)

		sessions.set(s, { session, calls: new Map(), closers, viewOnly })
		post({ t: "event", s, event: { type: "opened", info: openInfo(outcome.deck, outcome.package, viewOnly) } })

		if (request.options.window !== undefined)
			streamOpenWindow(session, request.options.window, handlers.render, scheduler, sessionSignal)
	}

	const call = async (message: Extract<ToPresentationWorker, { t: "call" }>): Promise<void> => {
		const { s, id, method } = message
		const live = sessions.get(s)

		if (live === undefined) {
			post({ t: "refused", s, id, reason: "closed", message: method })

			return
		}

		const viewOnlyAnswer = live.viewOnly ? VIEW_ONLY_ANSWERS[method] : undefined

		if (viewOnlyAnswer !== undefined) {
			post({ t: "result", s, id, method, value: viewOnlyAnswer } as FromPresentationWorker)

			return
		}

		const state = { aborted: false, listeners: [] as (() => void)[] }
		const signal: CallSignal = {
			get aborted() {
				return state.aborted
			},
			onAbort: listener => {
				state.listeners.push(listener)
			}
		}

		live.calls.set(id, state)

		const handler = handlers[method] as (context: CallContext, ...args: readonly unknown[]) => Promise<unknown>

		try {
			const lane = PRESENTATION_LANES[method]
			const value = await handler({ session: live.session, signal, lane, slicing: scheduler.slicing(lane) }, ...message.args)

			if (live.calls.get(id) !== state || state.aborted) return

			post({ t: "result", s, id, method, value } as FromPresentationWorker)
		} catch (error) {
			if (live.calls.get(id) !== state || state.aborted) return

			const reason = error instanceof PresentationError ? error.reason : "failed"

			post({ t: "refused", s, id, reason, message: error instanceof Error ? error.message : String(error) })
		} finally {
			if (live.calls.get(id) === state) live.calls.delete(id)
		}
	}

	const sourceOf = (spec: SourceSpec): ByteSource => {
		if (spec.kind === "bytes") return bytesSource(spec.bytes)

		if (options.rangeSource === undefined) throw new PresentationError("notImplemented", "range sources")

		return options.rangeSource(spec)
	}

	const listener = (event: { readonly data: unknown }): void => {
		const message = event.data

		if (!isMessage(message)) return

		switch (message.t) {
			case "open": {
				close(message.s)

				let source: ByteSource

				try {
					source = rebasableSource(sourceOf(message.source))
				} catch (error) {
					fail(message.s, error)

					return
				}

				void open(message.s, { source, sourceKind: message.source.kind, options: message.options })

				return
			}

			case "unlock": {
				const entry = pending.get(message.s)

				if (entry === undefined) {
					post({ t: "event", s: message.s, event: { type: "error", reason: "closed", message: "unlock" } })

					return
				}

				void open(message.s, { ...entry.request, password: message.password })

				return
			}

			case "abortOpen": {
				const entry = pending.get(message.s)

				if (entry !== undefined) {
					entry.aborted = true
					pending.delete(message.s)
					post({ t: "event", s: message.s, event: { type: "error", reason: "aborted", message: "open" } })
				}

				return
			}

			case "call":
				void call(message)

				return

			case "abort": {
				const live = sessions.get(message.s)
				const state = live?.calls.get(message.id)

				if (live === undefined || state === undefined) return

				state.aborted = true
				live.calls.delete(message.id)

				for (const abort of state.listeners) abort()

				post({ t: "refused", s: message.s, id: message.id, reason: "aborted", message: "" })

				return
			}

			case "dispose":
				close(message.s)

				return
		}
	}

	endpoint.addEventListener("message", listener)

	return () => {
		endpoint.removeEventListener("message", listener)

		for (const s of [...sessions.keys()]) close(s)

		pending.clear()
	}
}
