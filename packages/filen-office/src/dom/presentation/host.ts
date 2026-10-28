import type { ByteSource } from "../../core/opc/index"
import type { Format, PresentationRefusal } from "../../core/presentation/model"
import { servePresentation, type EngineServices, type OpenCapability, type PresentationEndpoint, type ServeOptions } from "./engine"
import { presentationTextServices } from "./engine/view"
import { realmScheduler } from "./scheduler"
import { clearTimer, isBitmap, offerSvgPort, setTimer, workerSvgRasterizer, type SvgPortMessage } from "./svgPort"
import { installPresentationRealm, type PresentationRealm } from "./services"
import {
	PRESENTATION_METHODS,
	transferablesOf,
	type FromPresentationWorker,
	type PresentationArgs,
	type PresentationEvent,
	type PresentationMethod,
	type PresentationOpenOptions,
	type PresentationSessionApi,
	type PresentationValue,
	type SourceSpec,
	type ToPresentationWorker
} from "./protocol"

// Both ends of the presentation worker. In the worker, servePresentationWorker serves the protocol with the realm's
// scheduler (8 ms slices, the priority lane first). On the page, presentationWorkerPool opens decks: each open deck
// has a worker of its own (a deck's heap never takes another down with it), and a worker whose deck closed is kept
// idle for a minute for the next deck, which then skips the worker's start-up and its font downloads.

// --- Worker side ---

// The worker's global scope as the protocol uses it.
export interface PresentationWorkerScope {
	postMessage(message: unknown, transfer: unknown[]): void
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
	removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
}

export interface PresentationWorkerOptions {
	// The worker's realm (workerRealm(self, fonts)): text measured and laid out here, canvases for the raster path.
	readonly realm?: PresentationRealm
	// A ByteSource over a range port (the web's block cache over the SDK worker's range server).
	readonly rangeSource?: (spec: Extract<SourceSpec, { kind: "range" }>) => ByteSource
	readonly openers?: { readonly [F in Format]?: OpenCapability }
	readonly services?: Partial<EngineServices>
	readonly handlers?: ServeOptions["handlers"]
}

// Serves the protocol on the worker's scope until the returned function stops it. The realm is installed for the
// capabilities, and the text services (a shape's chain, theme and box for layoutText) are registered with it.
export function servePresentationWorker(scope: PresentationWorkerScope, options: PresentationWorkerOptions = {}): () => void {
	const realm = options.realm
	const svg = workerSvgRasterizer(scope)

	if (realm !== undefined) installPresentationRealm({ ...realm, canvas: { ...realm.canvas, svg: svg.rasterize } })

	const endpoint: PresentationEndpoint = {
		postMessage: (message, transfer) => scope.postMessage(message, transfer),
		addEventListener: (type, listener) => scope.addEventListener(type, listener),
		removeEventListener: (type, listener) => scope.removeEventListener(type, listener)
	}

	const stop = servePresentation(endpoint, {
		scheduler: realmScheduler(),
		...(options.rangeSource === undefined ? {} : { rangeSource: options.rangeSource }),
		...(options.openers === undefined ? {} : { openers: options.openers }),
		services: { text: presentationTextServices, ...options.services },
		...(options.handlers === undefined ? {} : { handlers: options.handlers })
	})

	return () => {
		stop()
		svg.stop()
	}
}

// --- Page side ---

// The page's handle on a Worker (adapt one; tests use inThreadPresentationWorker).
export interface PresentationWorkerLike {
	postMessage(message: ToPresentationWorker | SvgPortMessage, transfer: unknown[]): void
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
	addEventListener(type: "error", listener: (event: unknown) => void): void
	terminate(): void
}

// A refused call: its typed reason (closed, aborted, notImplemented, stale…).
export class PresentationCallError extends Error {
	readonly reason: PresentationRefusal

	constructor(reason: PresentationRefusal, message: string) {
		super(message === "" ? reason : message)
		this.reason = reason
	}
}

export type PresentationListener = (event: PresentationEvent) => void

// One open deck: the session API plus what an open needs before its session exists.
export interface PresentationClient extends PresentationSessionApi {
	// The password of an encrypted deck (after an "error" event with needsPassword or wrongPassword).
	unlock(password: string): void
	// Gives up an open still under way.
	abortOpen(): void
	// Aborts one call by the promise it returned (it rejects as aborted).
	abort(call: Promise<unknown>): void
	readonly closed: boolean
}

export interface PresentationWorkerPool {
	open(source: SourceSpec, options: PresentationOpenOptions, listener: PresentationListener): PresentationClient
	// Starts a worker ahead of the first deck (its script is parsed while the file downloads).
	prewarm(): void
	// Workers alive (busy and idle), for tests and diagnostics.
	readonly workers: { readonly busy: number; readonly idle: number }
	dispose(): void
}

function isFromWorker(data: unknown): data is FromPresentationWorker {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as { t?: unknown }).t === "string" &&
		typeof (data as { s?: unknown }).s === "number"
	)
}

// Closes the bitmaps of a message nobody will receive (a closed deck's late thumbnails, layers or previews): a
// transferred bitmap holds its pixels until closed.
export function closeBitmapsOf(message: FromPresentationWorker): number {
	let closed = 0
	const close = (bitmap: unknown): void => {
		if (isBitmap(bitmap)) {
			bitmap.close()
			closed++
		}
	}

	if (message.t === "event" && message.event.type === "thumbs") for (const item of message.event.items) close(item.bitmap)

	if (message.t === "result") {
		if (message.method === "smartArtPreview") close(message.value)
		else if (message.method === "layers") for (const layer of message.value) close(layer.bitmap)
	}

	return closed
}

interface Pooled {
	readonly worker: PresentationWorkerLike
	// The deck it serves (one at a time), or undefined while idle.
	session: ((message: FromPresentationWorker) => void) | undefined
	fail: (() => void) | undefined
	idle: unknown
	dead: boolean
	// Ends the page's SVG raster service of this worker.
	closeSvg: (() => void) | undefined
}

export function presentationWorkerPool(create: () => PresentationWorkerLike, idleMs = 60_000): PresentationWorkerPool {
	const pool = new Set<Pooled>()
	let nextSession = 1

	const retire = (pooled: Pooled): void => {
		if (pooled.idle !== undefined) clearTimer(pooled.idle)

		pooled.idle = undefined
		pooled.dead = true
		pool.delete(pooled)
		pooled.closeSvg?.()
		pooled.worker.terminate()
	}

	const park = (pooled: Pooled): void => {
		pooled.session = undefined
		pooled.fail = undefined

		if (pooled.dead) return

		// One idle worker is kept; a second one is not worth its memory.
		for (const other of pool) {
			if (other !== pooled && other.session === undefined && !other.dead) {
				retire(pooled)

				return
			}
		}

		pooled.idle = setTimer(() => {
			pooled.idle = undefined

			if (pooled.session === undefined) retire(pooled)
		}, idleMs)
	}

	const spawn = (): Pooled => {
		const worker = create()
		const pooled: Pooled = { worker, session: undefined, fail: undefined, idle: undefined, dead: false, closeSvg: offerSvgPort(worker) }

		worker.addEventListener("message", event => {
			if (isFromWorker(event.data)) {
				if (pooled.session === undefined) closeBitmapsOf(event.data)
				else pooled.session(event.data)
			}
		})
		worker.addEventListener("error", () => {
			// The worker died (a defect or out of memory): its deck fails, the next deck starts a new one.
			const fail = pooled.fail

			retire(pooled)
			fail?.()
		})
		pool.add(pooled)

		return pooled
	}

	const take = (): Pooled => {
		for (const pooled of pool) {
			if (pooled.session === undefined && !pooled.dead) {
				if (pooled.idle !== undefined) clearTimer(pooled.idle)

				pooled.idle = undefined

				return pooled
			}
		}

		return spawn()
	}

	const open = (source: SourceSpec, options: PresentationOpenOptions, listener: PresentationListener): PresentationClient => {
		const pooled = take()
		const s = nextSession++
		const worker = pooled.worker
		const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
		const ids = new WeakMap<Promise<unknown>, number>()
		let closed = false
		let next = 1

		const post = (message: ToPresentationWorker): void => {
			worker.postMessage(message, transferablesOf(message))
		}

		const end = (reason: PresentationRefusal): void => {
			if (closed) return

			closed = true

			for (const call of calls.values()) call.reject(new PresentationCallError(reason, ""))

			calls.clear()
		}

		pooled.session = message => {
			if (closed || message.s !== s) {
				closeBitmapsOf(message)

				return
			}

			if (message.t === "event") {
				listener(message.event)

				return
			}

			const call = calls.get(message.id)

			if (call === undefined) {
				closeBitmapsOf(message)

				return
			}

			calls.delete(message.id)

			if (message.t === "result") call.resolve(message.value)
			else call.reject(new PresentationCallError(message.reason, message.message))
		}
		pooled.fail = () => {
			if (closed) return

			end("failed")
			listener({ type: "error", reason: "failed", message: "The presentation worker failed" })
		}

		post({ t: "open", s, source, options })

		const call = <M extends PresentationMethod>(method: M, ...args: PresentationArgs<M>): Promise<PresentationValue<M>> => {
			if (closed) return Promise.reject(new PresentationCallError("closed", method))

			const id = next++
			const answer = new Promise<PresentationValue<M>>((resolve, reject) => {
				calls.set(id, { resolve: value => resolve(value as PresentationValue<M>), reject })
			})

			ids.set(answer, id)
			post({ t: "call", s, id, method, args } as ToPresentationWorker)

			return answer
		}

		const methods = Object.fromEntries(
			PRESENTATION_METHODS.map(method => [method, (...args: unknown[]) => call(method, ...(args as PresentationArgs<typeof method>))])
		) as Omit<PresentationSessionApi, "close">

		return {
			...methods,
			get closed() {
				return closed
			},
			unlock(password) {
				if (!closed) post({ t: "unlock", s, password })
			},
			abortOpen() {
				if (!closed) post({ t: "abortOpen", s })
			},
			abort(promise) {
				const id = ids.get(promise)

				if (closed || id === undefined || !calls.has(id)) return

				post({ t: "abort", s, id })
			},
			close() {
				if (closed) return

				post({ t: "dispose", s })
				end("closed")

				if (pooled.session !== undefined && !pooled.dead) park(pooled)
			}
		}
	}

	return {
		open,
		prewarm() {
			for (const pooled of pool) if (!pooled.dead) return

			park(spawn())
		},
		get workers() {
			let busy = 0
			let idle = 0

			for (const pooled of pool) {
				if (pooled.dead) continue
				if (pooled.session === undefined) idle++
				else busy++
			}

			return { busy, idle }
		},
		dispose() {
			for (const pooled of [...pool]) {
				const fail = pooled.fail

				retire(pooled)
				fail?.()
			}
		}
	}
}

// --- In-thread ---

function cross<T>(message: T, transfer: unknown[]): T {
	const clone: unknown = Reflect.get(globalThis, "structuredClone")

	if (typeof clone !== "function") throw new Error("structuredClone is not available")

	return Reflect.apply(clone, globalThis, [message, { transfer }]) as T
}

// A worker stand-in on the page's own thread (tests, and realms without workers): messages are structured-cloned
// with their transferables moved and delivered on a later turn, exactly as a worker receives them, and the protocol
// is served by servePresentation with the options given.
export function inThreadPresentationWorker(options: ServeOptions = {}): PresentationWorkerLike {
	const toPage = new Set<(event: { readonly data: unknown }) => void>()
	const toWorker = new Set<(event: { readonly data: unknown }) => void>()
	let stopped = false
	const deliver = (listeners: Set<(event: { readonly data: unknown }) => void>, data: unknown): void => {
		void Promise.resolve().then(() => {
			if (stopped) return

			for (const listener of listeners) listener({ data })
		})
	}
	const endpoint: PresentationEndpoint = {
		postMessage: (message, transfer) => deliver(toPage, cross(message, transfer)),
		addEventListener: (_type, listener) => toWorker.add(listener),
		removeEventListener: (_type, listener) => toWorker.delete(listener)
	}
	const stop = servePresentation(endpoint, options)

	return {
		postMessage: (message, transfer) => deliver(toWorker, cross(message, transfer)),
		addEventListener: (type: "message" | "error", listener: (event: { readonly data: unknown }) => void) => {
			if (type === "message") toPage.add(listener)
		},
		terminate() {
			if (stopped) return

			stopped = true
			stop()
		}
	}
}
