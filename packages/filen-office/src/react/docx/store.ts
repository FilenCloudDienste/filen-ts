import { appendAll } from "../../core/arrays"
import type { DecorationValue } from "../../core/docx/layout/index"
import type { FontHost } from "../../core/fonts/index"
import type { ByteSource } from "../../core/opc/index"
import type { DocxHost } from "../../dom/docx/host"
import type {
	DocxErrorReason,
	DocxEvent,
	DocxFontFace,
	DocxLinkTarget,
	DocxOpenInfo,
	DocxOpenOptions,
	DocxPageData,
	DocxSessionApi,
	DocxTextStyle
} from "../../dom/docx/protocol"
import { fontFaceHost } from "../../dom/fontFaceHost"
import { DocxMediaCache } from "./media"

// The renderer's side of an open document: pages as they stream in, the style/decoration/link tables they
// index, and the session to ask for objects and media. Snapshots are immutable per change, so a view can
// subscribe with useSyncExternalStore and skip work when nothing changed.

export interface DocxSource {
	readonly host: DocxHost
	readonly bytes: ByteSource
	readonly options?: DocxOpenOptions
	// Where faces the engine registered in another realm (a worker) are registered again for drawing; the
	// page's own document fonts by default. Not used by an in-thread host.
	readonly fontHost?: FontHost
}

// Grow-only tables the pages index into. Shared by reference: a page painted once never needs a newer copy.
export interface DocxTables {
	readonly styles: readonly DocxTextStyle[]
	readonly decorations: readonly DecorationValue[]
	readonly links: readonly DocxLinkTarget[]
}

export type DocxStatus = "loading" | "streaming" | "ready" | "error"

export interface DocxDocument {
	readonly status: DocxStatus
	readonly info: DocxOpenInfo | undefined
	readonly pages: readonly DocxPageData[]
	// Final count once ready, else the larger of the pages so far and the estimate.
	readonly pageCount: number
	readonly tables: DocxTables
	readonly session: DocxSessionApi | undefined
	// Object URLs of the document's images; revoked when the document closes.
	readonly media: DocxMediaCache | undefined
	readonly error: { readonly reason: DocxErrorReason; readonly message: string; readonly mainPartBytes: number | undefined } | undefined
}

const EMPTY_TABLES: DocxTables = { styles: [], decorations: [], links: [] }

export const IDLE_DOCUMENT: DocxDocument = {
	status: "loading",
	info: undefined,
	pages: [],
	pageCount: 0,
	tables: EMPTY_TABLES,
	session: undefined,
	media: undefined,
	error: undefined
}

function documentFontHost(): FontHost | undefined {
	const doc: unknown = Reflect.get(globalThis, "document")
	const FontFaceClass: unknown = Reflect.get(globalThis, "FontFace")
	const fonts = typeof doc === "object" && doc !== null ? Reflect.get(doc, "fonts") : undefined

	if (typeof FontFaceClass !== "function" || typeof fonts !== "object" || fonts === null) return undefined

	return fontFaceHost({ FontFace: FontFaceClass as never, fonts: fonts as never })
}

export class DocxDocumentStore {
	private readonly source: DocxSource
	private readonly listeners = new Set<() => void>()
	private snapshot: DocxDocument = IDLE_DOCUMENT
	private session: DocxSessionApi | undefined = undefined
	private media: DocxMediaCache | undefined = undefined
	private started = false
	private disposed = false
	private disposeTimer: ReturnType<typeof setTimeout> | undefined = undefined
	private readonly styles: DocxTextStyle[] = []
	private readonly decorations: DecorationValue[] = []
	private readonly links: DocxLinkTarget[] = []
	private readonly tables: DocxTables = { styles: this.styles, decorations: this.decorations, links: this.links }
	private pages: DocxPageData[] = []
	// Pages wait for the faces sent before them, so text never paints in a fallback face first.
	private fontsReady: Promise<unknown> = Promise.resolve()
	// Every face sent so far is loaded.
	private fontsLoaded = true
	// Events waiting in the queue.
	private queued = 0
	private fontHost: FontHost | undefined = undefined
	private readonly families = new Set<string>()
	// Events are applied in order, each after the fonts before it are loaded.
	private queue: Promise<void> = Promise.resolve()

	constructor(source: DocxSource) {
		this.source = source
	}

	getSnapshot = (): DocxDocument => this.snapshot

	// Opens the document on the first subscriber; closes it shortly after the last one leaves (a remount
	// in the same commit, as StrictMode does, keeps it).
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

		const session = this.source.host(this.source.bytes, event => this.receive(event), this.source.options)

		this.session = session
		this.media = new DocxMediaCache(session)
		this.media.fontsReady = () => this.fontsReady
		this.set({ ...this.snapshot, session, media: this.media })
	}

	private set(next: DocxDocument): void {
		this.snapshot = next

		for (const listener of this.listeners) listener()
	}

	private receive(event: DocxEvent): void {
		if (this.disposed) return

		if (event.type === "fonts") {
			this.registerFonts(event.faces)

			return
		}

		// Nothing waiting and every face loaded (the session open): applied at once, in the task that sent it
		// (pages an edit laid out reach a view in the same render as the edit).
		if (this.queued === 0 && this.fontsLoaded && this.session !== undefined) {
			this.apply(event)

			return
		}

		const fonts = this.fontsReady

		this.queued++
		this.queue = this.queue.then(async () => {
			if (event.type === "pages") await fonts

			this.queued--

			if (!this.disposed) this.apply(event)
		})
	}

	private registerFonts(faces: readonly DocxFontFace[]): void {
		this.fontHost ??= this.source.fontHost ?? documentFontHost()

		const host = this.fontHost

		if (host === undefined) return

		const loads: Promise<boolean>[] = []

		for (const face of faces) {
			this.families.add(face.face.family)
			loads.push(face.kind === "bytes" ? host.addBytes(face.face, face.bytes) : host.addLocal(face.face, face.name))
		}

		const ready = Promise.all([this.fontsReady, ...loads]).catch(() => undefined)

		this.fontsReady = ready
		this.fontsLoaded = false
		void ready.then(() => {
			if (this.fontsReady === ready) this.fontsLoaded = true
		})
	}

	private apply(event: Exclude<DocxEvent, { type: "fonts" }>): void {
		const current = this.snapshot

		switch (event.type) {
			case "opened":
				this.set({ ...current, info: event.info, pageCount: Math.max(current.pageCount, event.info.estimatedPages) })

				break
			case "pages": {
				appendAll(this.styles, event.styles)
				appendAll(this.decorations, event.decorations)
				appendAll(this.links, event.links)

				if (event.pages.length > 0) {
					const pages = this.pages.slice()

					for (const page of event.pages) pages[page.index] = page

					this.pages = pages
				}

				const estimate = current.info?.estimatedPages ?? 0

				this.set({
					...current,
					status: event.final ? "ready" : this.pages.length > 0 ? "streaming" : "loading",
					pages: this.pages,
					pageCount: event.final ? event.pageCount : Math.max(this.pages.length, estimate),
					tables: this.tables
				})

				break
			}
			case "error":
				this.set({
					...current,
					status: "error",
					error: {
						reason: event.reason,
						message: event.message,
						mainPartBytes: event.mainPartBytes ?? current.info?.mainPartBytes
					}
				})
				this.closeSession()

				break
		}
	}

	private closeSession(): void {
		this.session?.close()
	}

	dispose(): void {
		if (this.disposed) return

		this.disposed = true
		this.closeSession()
		this.media?.dispose()
		this.session = undefined
		this.media = undefined

		const host = this.fontHost

		if (host !== undefined) for (const family of this.families) host.remove(family)

		this.families.clear()
		this.pages = []
		this.listeners.clear()
	}
}
