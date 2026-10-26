import { useSyncExternalStore } from "react"
import type { FontHost } from "../../core/fonts/index"
import type { PresentationRefusal, SlideRef } from "../../core/presentation/model"
import type { DocxFontFace } from "../../dom/docx/protocol"
import { fontFaceHost } from "../../dom/fontFaceHost"
import type {
	BitmapLike,
	OpenInfo,
	PresentationEvent,
	PresentationNotice,
	PresentationOpenOptions,
	PresentationSessionApi,
	SlideRender,
	SourceSpec
} from "../../dom/presentation/protocol"
import { releaseSlidePictures } from "./paint/slide"

// The page's side of an open deck: what the worker said about it, the renders of the slides around the one shown
// and the rail's thumbnails. Memory is bounded whatever the deck's size: renders are kept only inside a window
// around the current slide, thumbnails in a byte-bounded LRU whose evicted bitmaps are closed. Snapshots are
// immutable per change, for useSyncExternalStore.
//
// Worker time goes to what is on screen first. The open window streams in ("slides", the shown slide first); after
// it, the rest of the render window is asked for one slide at a time, nearest first, and a move of the window stops
// that run and aborts the slide in flight when the new window no longer holds it. Thumbnail batches for slides the
// rail no longer shows are aborted.

export interface PresentationConnection {
	readonly session: PresentationSessionApi
	// The password of an encrypted deck; answered by "opened" or an error event.
	unlock(password: string): void
	// Aborts one call by the promise the session returned (it rejects as aborted); absent: calls run to their end.
	abort?(call: Promise<unknown>): void
	dispose(): void
}

export type PresentationHost = (
	source: SourceSpec,
	listener: (event: PresentationEvent) => void,
	options: PresentationOpenOptions
) => PresentationConnection

export interface PresentationStoreOptions {
	readonly host: PresentationHost
	readonly source: SourceSpec
	readonly options: PresentationOpenOptions
	// Where faces the worker registered are registered again for drawing; the page's document fonts by default.
	readonly fontHost?: FontHost
	// Renders kept and requested: the current slide ± this.
	readonly renderWindow?: number
	// Thumbnail bitmaps kept, in bytes (4 per pixel).
	readonly thumbBytes?: number
}

export interface PresentationThumb {
	readonly bitmap: BitmapLike
	readonly revision: number
	// The width it was asked at.
	readonly width: number
	// Its slide changed since; a new one is asked for when the rail shows it.
	readonly stale: boolean
}

export type PresentationStatus = "loading" | "password" | "streaming" | "ready" | "error"

export interface PresentationDocument {
	readonly status: PresentationStatus
	readonly info: OpenInfo | undefined
	readonly slides: readonly { readonly ref: SlideRef; readonly hidden: boolean }[]
	readonly renders: ReadonlyMap<SlideRef, SlideRender>
	readonly thumbs: ReadonlyMap<SlideRef, PresentationThumb>
	readonly revision: number
	readonly dirty: boolean
	readonly notices: readonly PresentationNotice[]
	readonly password: { readonly wrong: boolean } | undefined
	readonly error: { readonly reason: PresentationRefusal; readonly message: string } | undefined
	readonly session: PresentationSessionApi | undefined
	// The slide index the render window is centred on.
	readonly window: number
}

export interface PresentationStore {
	getSnapshot(): PresentationDocument
	subscribe(listener: () => void): () => void
	setWindow(index: number): void
	requestThumbnails(refs: readonly SlideRef[], widthPx: number): void
	unlock(password: string): void
	dismissNotice(notice: PresentationNotice): void
	dispose(): void
}

export const DEFAULT_RENDER_WINDOW = 10
export const DEFAULT_THUMB_BYTES = 24 * 1024 * 1024

export const IDLE_PRESENTATION: PresentationDocument = {
	status: "loading",
	info: undefined,
	slides: [],
	renders: new Map(),
	thumbs: new Map(),
	revision: 0,
	dirty: false,
	notices: [],
	password: undefined,
	error: undefined,
	session: undefined,
	window: 0
}

function documentFontHost(): FontHost | undefined {
	const doc: unknown = Reflect.get(globalThis, "document")
	const FontFaceClass: unknown = Reflect.get(globalThis, "FontFace")
	const fonts = typeof doc === "object" && doc !== null ? Reflect.get(doc, "fonts") : undefined

	if (typeof FontFaceClass !== "function" || typeof fonts !== "object" || fonts === null) return undefined

	return fontFaceHost({ FontFace: FontFaceClass as never, fonts: fonts as never })
}

interface ThumbBatch {
	readonly refs: SlideRef[]
	readonly width: number
	call?: Promise<void>
}

function thumbBytes(bitmap: BitmapLike): number {
	return bitmap.width * bitmap.height * 4
}

function noticeKey(notice: PresentationNotice): string {
	return JSON.stringify(notice)
}

class Store implements PresentationStore {
	private readonly config: PresentationStoreOptions
	private readonly radius: number
	private readonly budget: number
	private readonly listeners = new Set<() => void>()
	private snapshot: PresentationDocument = IDLE_PRESENTATION
	private connection: PresentationConnection | undefined = undefined
	private started = false
	private disposed = false
	private disposeTimer: ReturnType<typeof setTimeout> | undefined = undefined
	// Recency order: the first entry is evicted first.
	private readonly thumbs = new Map<SlideRef, PresentationThumb>()
	private bytes = 0
	private readonly renders = new Map<SlideRef, SlideRender>()
	private readonly pendingRenders = new Set<SlideRef>()
	// The open window's slides still to arrive by "slides" events.
	private readonly streamed = new Set<SlideRef>()
	// The run of render calls for the current window: a new window starts a new run, which ends the old one.
	private run = 0
	private inFlight: { readonly ref: SlideRef; readonly call: Promise<unknown> } | undefined = undefined
	// The batch each pending thumbnail is in.
	private readonly pendingThumbs = new Map<SlideRef, ThumbBatch>()
	private readonly batches = new Set<ThumbBatch>()
	private batch: ThumbBatch | undefined = undefined
	// The width each pending thumbnail was asked at.
	private readonly widths = new Map<SlideRef, number>()
	// Deck index per slide ref, for the current slide list.
	private indices = new Map<SlideRef, number>()
	private fontHost: FontHost | undefined = undefined
	private readonly families = new Set<string>()
	// Renders wait for the faces sent before them, so text never paints in a fallback face first.
	private fontsReady: Promise<unknown> = Promise.resolve()

	constructor(config: PresentationStoreOptions) {
		this.config = config
		this.radius = Math.max(0, config.renderWindow ?? DEFAULT_RENDER_WINDOW)
		this.budget = Math.max(0, config.thumbBytes ?? DEFAULT_THUMB_BYTES)
		this.snapshot = { ...IDLE_PRESENTATION, window: Math.max(0, config.options.window?.from ?? 0) }
	}

	getSnapshot = (): PresentationDocument => this.snapshot

	// Opens the deck on the first subscriber; closes it shortly after the last one leaves (a remount in the same
	// commit, as StrictMode does, keeps it).
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		if (this.disposeTimer !== undefined) {
			clearTimeout(this.disposeTimer)
			this.disposeTimer = undefined
		}

		this.start()

		return () => {
			this.listeners.delete(listener)

			if (this.listeners.size === 0 && this.disposeTimer === undefined) {
				this.disposeTimer = setTimeout(() => {
					this.disposeTimer = undefined

					if (this.listeners.size === 0) this.dispose()
				}, 0)
			}
		}
	}

	private start(): void {
		if (this.started || this.disposed) return

		this.started = true

		const connection = this.config.host(this.config.source, event => this.receive(event), this.config.options)

		this.connection = connection
		this.set({ session: connection.session })
	}

	private set(change: Partial<PresentationDocument>): void {
		if (change.slides !== undefined && change.slides !== this.snapshot.slides) {
			this.indices = new Map(change.slides.map((slide, index) => [slide.ref, index]))
		}

		this.snapshot = { ...this.snapshot, ...change }

		for (const listener of this.listeners) listener()
	}

	private inWindow(ref: SlideRef, center = this.snapshot.window): boolean {
		const index = this.indices.get(ref)

		return index !== undefined && Math.abs(index - center) <= this.radius
	}

	private receive(event: PresentationEvent): void {
		if (this.disposed) return

		switch (event.type) {
			case "opened":
				this.opened(event.info)
				break
			case "fonts":
				this.registerFonts(event.faces)
				break
			case "slides": {
				const fonts = this.fontsReady

				void fonts.then(() => {
					if (this.disposed) return

					for (const render of event.renders) {
						this.streamed.delete(render.ref)
						this.pendingRenders.delete(render.ref)
					}

					this.addRenders(event.renders)

					if (!event.final) return

					// A slide the stream could not render is asked for by the window like any other.
					for (const ref of this.streamed) this.pendingRenders.delete(ref)

					this.streamed.clear()

					if (this.snapshot.status === "streaming") this.set({ status: "ready" })

					this.fetchWindow()
				})

				break
			}
			case "thumbs":
				this.addThumbs(event.items)
				break
			case "changed":
				this.changed(event)
				break
			case "notice": {
				const key = noticeKey(event.notice)

				if (!this.snapshot.notices.some(notice => noticeKey(notice) === key)) {
					this.set({ notices: [...this.snapshot.notices, event.notice] })
				}

				break
			}
			case "error":
				if (event.reason === "needsPassword" || event.reason === "wrongPassword") {
					this.set({ status: "password", password: { wrong: event.reason === "wrongPassword" } })
				} else {
					this.set({ status: "error", password: undefined, error: { reason: event.reason, message: event.message } })
					this.closeConnection()
				}

				break
			case "saveProgress":
				break
		}
	}

	private opened(info: OpenInfo): void {
		const center = Math.min(this.snapshot.window, Math.max(0, info.slides.length - 1))
		const window = this.config.options.window
		const streaming = window !== undefined && window.count >= 1 && info.slides.length > 0

		if (streaming) {
			// The worker sends these by itself (the protocol's open window); asked for again, they would render twice.
			const from = Math.min(info.slides.length - 1, Math.max(0, Math.trunc(window.from)))

			for (const slide of info.slides.slice(from, from + Math.trunc(window.count))) {
				this.streamed.add(slide.ref)
				this.pendingRenders.add(slide.ref)
			}
		}

		this.set({ status: streaming ? "streaming" : "ready", info, slides: info.slides, password: undefined, window: center })

		// The rest of the window waits for the stream, so the shown slide has the worker to itself.
		if (!streaming) this.fetchWindow()
	}

	private registerFonts(faces: readonly DocxFontFace[]): void {
		this.fontHost ??= this.config.fontHost ?? documentFontHost()

		const host = this.fontHost

		if (host === undefined) return

		const loads: Promise<boolean>[] = []

		for (const face of faces) {
			this.families.add(face.face.family)
			loads.push(face.kind === "bytes" ? host.addBytes(face.face, face.bytes) : host.addLocal(face.face, face.name))
		}

		this.fontsReady = Promise.all([this.fontsReady, ...loads]).catch(() => undefined)
	}

	private addRenders(renders: readonly SlideRender[]): void {
		let changed = false

		for (const render of renders) {
			this.pendingRenders.delete(render.ref)

			const known = this.renders.get(render.ref)

			// Outside the window: not kept (it is asked for again when the window reaches it).
			if (!this.inWindow(render.ref) || (known !== undefined && known.revision > render.revision)) continue

			this.renders.set(render.ref, render)
			changed = true
		}

		if (changed) this.set({ renders: new Map(this.renders) })
	}

	// The window's slides not rendered or asked for yet: the current one first, then by distance from it.
	private wantedRefs(center: number): SlideRef[] {
		const slides = this.snapshot.slides
		const out: SlideRef[] = []

		for (let distance = 0; distance <= this.radius; distance++) {
			for (const index of distance === 0 ? [center] : [center + distance, center - distance]) {
				const ref = slides[index]?.ref

				if (ref !== undefined && !this.renders.has(ref) && !this.pendingRenders.has(ref)) out.push(ref)
			}
		}

		return out
	}

	// Starts a run over the window: one slide per call, so a move of the window costs at most the slide in flight.
	private fetchWindow(): void {
		if (this.connection === undefined || this.snapshot.info === undefined || this.disposed) return

		void this.renderRun(++this.run)
	}

	private async renderRun(run: number): Promise<void> {
		while (run === this.run && !this.disposed) {
			const session = this.connection?.session
			const ref = this.wantedRefs(this.snapshot.window)[0]

			if (session === undefined || ref === undefined) return

			this.pendingRenders.add(ref)

			const call = session.render([ref])
			const fonts = this.fontsReady

			this.inFlight = { ref, call }

			try {
				const renders = await call

				await fonts

				if (!this.disposed) this.addRenders(renders)
			} catch {
				// Aborted, closed or refused: a later window asks again.
			} finally {
				this.pendingRenders.delete(ref)

				if (this.inFlight?.call === call) this.inFlight = undefined
			}
		}
	}

	setWindow = (index: number): void => {
		const count = this.snapshot.slides.length
		const center = count === 0 ? 0 : Math.min(count - 1, Math.max(0, Math.trunc(index)))

		if (center === this.snapshot.window && this.started) {
			this.fetchWindow()

			return
		}

		let dropped = false

		for (const ref of this.renders.keys()) {
			if (!this.inWindow(ref, center)) {
				this.renders.delete(ref)
				dropped = true
			}
		}

		// The slide in flight for a window the user left is no longer worth the worker's time.
		const flying = this.inFlight

		if (flying !== undefined && !this.inWindow(flying.ref, center)) {
			this.inFlight = undefined
			this.connection?.abort?.(flying.call)
		}

		this.set(dropped ? { window: center, renders: new Map(this.renders) } : { window: center })
		this.fetchWindow()
	}

	private changed(event: Extract<PresentationEvent, { type: "changed" }>): void {
		const info =
			this.snapshot.info === undefined || event.info === undefined ? this.snapshot.info : { ...this.snapshot.info, ...event.info }
		const slides = info?.slides ?? this.snapshot.slides
		const present = new Set(slides.map(slide => slide.ref))
		let thumbsChanged = false

		for (const ref of event.slides) this.renders.delete(ref)

		for (const [ref, thumb] of this.thumbs) {
			if (!present.has(ref)) {
				this.removeThumb(ref, thumb)
				thumbsChanged = true
			} else if (event.slides.includes(ref) && !thumb.stale) {
				this.thumbs.set(ref, { ...thumb, stale: true })
				thumbsChanged = true
			}
		}

		for (const ref of this.renders.keys()) if (!present.has(ref)) this.renders.delete(ref)

		const center = Math.min(this.snapshot.window, Math.max(0, slides.length - 1))

		this.set({
			info,
			slides,
			revision: event.revision,
			dirty: event.dirty,
			window: center,
			renders: new Map(this.renders),
			...(thumbsChanged ? { thumbs: new Map(this.thumbs) } : {})
		})
		this.fetchWindow()
	}

	private removeThumb(ref: SlideRef, thumb: PresentationThumb): void {
		this.thumbs.delete(ref)
		this.bytes -= thumbBytes(thumb.bitmap)
		thumb.bitmap.close()
	}

	private addThumbs(items: readonly { readonly slide: SlideRef; readonly revision: number; readonly bitmap: BitmapLike }[]): void {
		const present = this.indices
		let changed = false

		for (const item of items) {
			this.pendingThumbs.delete(item.slide)

			const known = this.thumbs.get(item.slide)

			if (
				!present.has(item.slide) ||
				(known !== undefined && known.revision > item.revision) ||
				thumbBytes(item.bitmap) > this.budget
			) {
				item.bitmap.close()
				continue
			}

			if (known !== undefined) this.removeThumb(item.slide, known)

			this.thumbs.set(item.slide, {
				bitmap: item.bitmap,
				revision: item.revision,
				width: this.widths.get(item.slide) ?? item.bitmap.width,
				stale: false
			})
			this.widths.delete(item.slide)
			this.bytes += thumbBytes(item.bitmap)
			changed = true
		}

		for (const [ref, thumb] of this.thumbs) {
			if (this.bytes <= this.budget) break

			this.removeThumb(ref, thumb)
		}

		if (changed) this.set({ thumbs: new Map(this.thumbs) })
	}

	// `refs` are what the rail shows now, in the order they matter (the slides in view first). One batch is in flight
	// at a time: a request that the batch in flight does not cover, or that leaves some of its slides behind, aborts it
	// and asks again in the new order, so a fast scroll never queues thumbnails nobody sees ahead of the ones in view.
	// The worker keeps the pictures it decoded, so what an abort cut short costs little the next time.
	requestThumbnails = (refs: readonly SlideRef[], widthPx: number): void => {
		const session = this.connection?.session

		if (session === undefined || this.disposed || this.snapshot.info === undefined) return

		const width = Math.max(1, Math.round(widthPx))
		const wanted: SlideRef[] = []

		for (const ref of refs) {
			const known = this.thumbs.get(ref)

			if (known !== undefined) {
				// Most recently used: evicted last.
				this.thumbs.delete(ref)
				this.thumbs.set(ref, known)

				if (!known.stale && known.width === width) continue
			}

			wanted.push(ref)
		}

		const shown = new Set(refs)
		const covered = wanted.every(ref => this.pendingThumbs.get(ref)?.width === width)
		const stray = [...this.pendingThumbs.keys()].some(ref => !shown.has(ref))

		if (covered && !stray) return

		for (const batch of [...this.batches, ...(this.batch === undefined ? [] : [this.batch])]) {
			this.releaseBatch(batch)

			if (batch.call !== undefined) this.connection?.abort?.(batch.call)
		}

		this.batches.clear()
		this.batch = undefined

		if (wanted.length === 0) return

		const batch: ThumbBatch = { refs: wanted, width }

		for (const ref of wanted) {
			this.pendingThumbs.set(ref, batch)
			this.widths.set(ref, width)
		}

		this.batch = batch
		queueMicrotask(() => {
			if (this.batch === batch) this.flush()
		})
	}

	// Forgets the batch's slides still pending in it (they are asked for again when shown).
	private releaseBatch(batch: ThumbBatch): void {
		for (const ref of batch.refs) {
			if (this.pendingThumbs.get(ref) === batch) {
				this.pendingThumbs.delete(ref)
				this.widths.delete(ref)
			}
		}
	}

	private flush(): void {
		const batch = this.batch
		const session = this.connection?.session

		this.batch = undefined

		if (batch === undefined || batch.refs.length === 0) return

		if (session === undefined || this.disposed) {
			this.releaseBatch(batch)

			return
		}

		const call = session.thumbnails(batch.refs, batch.width)
		const done = (): void => {
			this.batches.delete(batch)
			this.releaseBatch(batch)
		}

		batch.call = call
		this.batches.add(batch)
		call.then(done, done)
	}

	unlock = (password: string): void => {
		if (this.snapshot.status !== "password") return

		// The password stays set, so the page keeps its prompt up until the worker answers.
		this.set({ status: "loading" })
		this.connection?.unlock(password)
	}

	dismissNotice = (notice: PresentationNotice): void => {
		const key = noticeKey(notice)
		const notices = this.snapshot.notices.filter(candidate => noticeKey(candidate) !== key)

		if (notices.length !== this.snapshot.notices.length) this.set({ notices })
	}

	// Ends the session (a worker failure ends it too, before the page lets go of the store): the slides' picture URLs
	// go with it.
	private closeConnection(): void {
		const connection = this.connection

		this.connection = undefined
		connection?.dispose()

		if (connection !== undefined) releaseSlidePictures(connection.session)
	}

	dispose = (): void => {
		if (this.disposed) return

		this.disposed = true

		if (this.disposeTimer !== undefined) clearTimeout(this.disposeTimer)

		this.closeConnection()

		for (const thumb of this.thumbs.values()) thumb.bitmap.close()

		this.thumbs.clear()
		this.bytes = 0
		this.renders.clear()

		const host = this.fontHost

		if (host !== undefined) for (const family of this.families) host.remove(family)

		this.families.clear()
		this.snapshot = { ...this.snapshot, renders: new Map(), thumbs: new Map(), session: undefined }
		this.listeners.clear()
	}
}

export function createPresentationStore(options: PresentationStoreOptions): PresentationStore {
	return new Store(options)
}

export function usePresentationDocument(store: PresentationStore): PresentationDocument {
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
