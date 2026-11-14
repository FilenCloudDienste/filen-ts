import type { PdfAnnotationInfo, PdfAnnotationRef, PdfCommentThread, PdfPoint } from "@filen/office/core/pdfedit/annotations"
import type { PdfAttachmentInfo } from "@filen/office/core/pdfedit/annotations"
import type { PdfEditSessionModel, PdfEditSnapshot } from "@filen/office/react/pdfedit"
import type { ToolKey } from "@filen/office/react/pdfedit/tools"
import type { PdfEditSwap } from "@/features/pdf/session/swap"
import type { PdfStampImage } from "@/features/pdf/annotations/stampImage"

// What the annotation tools share across the pages' overlays, the popover and the Comments panel, one per editing
// swap: the selection, the editor's annotations of the pages shown and its comment threads (read once, read again
// only for the pages a change touched), the sticky note or comment being written, the chosen stamp picture, the
// drawing the ink tool adds strokes to, and a temporary hand while Space is held. Views subscribe
// (useSyncExternalStore: subscribe / getState).

// A comment being written in the Comments panel: a new sticky note at a point, or the note of an annotation that has
// none yet.
export type PdfComposing =
	{ readonly kind: "note"; readonly page: number; readonly at: PdfPoint } | { readonly kind: "comment"; readonly ref: PdfAnnotationRef }

// A stamp picture waiting for its place, or a place waiting for its picture (a click with no picture chosen yet).
export interface PdfStampPlacement {
	readonly page: number
	readonly at: PdfPoint
	// The page box, to keep the stamp inside.
	readonly box: readonly [number, number, number, number]
	// Where the picture is picked: this device's files, or Filen.
	readonly source: "device" | "filen"
}

export interface PdfAnnotationState {
	readonly selected: PdfAnnotationInfo | null
	readonly commentsOpen: boolean
	readonly composing: PdfComposing | null
	readonly hand: boolean
	readonly image: PdfStampImage | null
	// A place clicked for a picture not chosen yet: the host asks for one.
	readonly imageWanted: PdfStampPlacement | null
	readonly attachmentsOpen: boolean
	// Bumped when the editor's annotations or threads change (a view reads them through the store).
	readonly revision: number
}

const INITIAL: PdfAnnotationState = {
	selected: null,
	commentsOpen: false,
	composing: null,
	hand: false,
	image: null,
	imageWanted: null,
	attachmentsOpen: false,
	revision: 0
}

// Most pages one annotations read asks for (the engine's own limit).
const READ_BATCH = 64

export class PdfAnnotationStore {
	private state: PdfAnnotationState = INITIAL
	private readonly listeners = new Set<() => void>()
	private session: PdfEditSessionModel | null = null
	private unsubscribe: (() => void) | null = null
	private shown: PdfEditSnapshot["document"] | null = null
	// The editor's annotations by 0-based page, and the pages asked for (answered or not).
	private readonly pages = new Map<number, readonly PdfAnnotationInfo[]>()
	private readonly asked = new Set<number>()
	private wanted: number[] = []
	// Comment threads by page once read (all pages), null before.
	private threads: Map<number, readonly PdfCommentThread[]> | null = null
	private threadsAsked = false
	private attachmentList: readonly PdfAttachmentInfo[] | null = null
	// The drawing the ink tool's next stroke joins, while nothing else changed the document.
	private ink: { readonly page: number; readonly id: number; readonly revision: number } | null = null
	private askAuthor: (() => Promise<string | null>) | null = null
	private readonly keys = new Map<number, (key: ToolKey) => boolean>()

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	getState = (): PdfAnnotationState => this.state

	private set(change: Partial<PdfAnnotationState>): void {
		this.state = { ...this.state, ...change }

		for (const listener of this.listeners) listener()
	}

	private changed(): void {
		this.set({ revision: this.state.revision + 1 })
	}

	// The editor's session (null before the swap or after it ended): its changes keep the read annotations current.
	bind(session: PdfEditSessionModel | null): void {
		if (session === this.session) return

		this.unsubscribe?.()
		this.unsubscribe = null
		this.session = session
		this.shown = null
		this.pages.clear()
		this.asked.clear()
		this.wanted = []
		this.threads = null
		this.threadsAsked = false
		this.attachmentList = null
		this.ink = null

		if (session !== null) {
			this.shown = session.getSnapshot().document
			this.unsubscribe = session.subscribe(() => {
				this.follow(session.getSnapshot())
			})
		}

		this.set({ selected: null, composing: null, revision: this.state.revision + 1 })
	}

	// A change made a new revision of the document: what it touched is read again when next wanted.
	private follow(snapshot: PdfEditSnapshot): void {
		if (snapshot.document === this.shown) return

		this.shown = snapshot.document

		for (const page of snapshot.touched) {
			this.pages.delete(page)
			this.asked.delete(page)
		}

		if (this.threads !== null && snapshot.touched.length > 0) void this.readThreads(snapshot.touched)

		this.attachmentList = null
		this.changed()
	}

	// --- The editor's annotations ---

	// A page's annotations as the editor has them, or null while they are read (asked for here).
	annotations(page: number): readonly PdfAnnotationInfo[] | null {
		const known = this.pages.get(page)

		if (known !== undefined) return known

		if (this.session !== null && !this.asked.has(page)) {
			this.asked.add(page)
			this.wanted.push(page)

			if (this.wanted.length === 1) {
				queueMicrotask(() => {
					void this.flush()
				})
			}
		}

		return null
	}

	private async flush(): Promise<void> {
		const session = this.session
		const pages = this.wanted.splice(0)

		if (session === null || pages.length === 0) return

		for (let at = 0; at < pages.length; at += READ_BATCH) {
			const batch = pages.slice(at, at + READ_BATCH)
			const read = await session.engine.call("annotations", { pages: batch }).catch(() => null)

			if (session !== this.session) return

			if (read === null) {
				for (const page of batch) this.asked.delete(page)

				continue
			}

			for (const entry of read) if (this.asked.has(entry.page)) this.pages.set(entry.page, entry.annotations)
		}

		this.refreshSelection()
		this.changed()
	}

	// The selected annotation's info follows the document (moved, restyled, gone).
	private refreshSelection(): void {
		const selected = this.state.selected
		const page = selected === null ? undefined : this.pages.get(selected.page)

		if (selected === null || page === undefined) return

		const now = page.find(info => info.id === selected.id) ?? null

		if (now !== selected) this.set({ selected: now })
	}

	// --- Selection ---

	select(info: PdfAnnotationInfo | null): void {
		if (info === null && this.state.selected === null) return

		this.set({ selected: info })
	}

	// Selects the annotation `ref` once its page's annotations are read again (a new one, after its command).
	selectRef(ref: PdfAnnotationRef): void {
		const found = this.annotations(ref.page)?.find(info => info.id === ref.id)

		if (found !== undefined) {
			this.select(found)

			return
		}

		const unsubscribe = this.subscribe(() => {
			const info = this.pages.get(ref.page)?.find(entry => entry.id === ref.id)

			if (info !== undefined) {
				unsubscribe()
				this.select(info)
			}
		})

		// Not read in time (the page left the view): no selection.
		setTimeout(unsubscribe, 5000)
	}

	// --- Comments ---

	openComments(open: boolean): void {
		if (open && this.threads === null && !this.threadsAsked) void this.readThreads(null)

		this.set({ commentsOpen: open, ...(open ? {} : { composing: null }) })
	}

	compose(composing: PdfComposing | null): void {
		if (composing !== null && this.threads === null && !this.threadsAsked) void this.readThreads(null)

		this.set({ composing, ...(composing === null ? {} : { commentsOpen: true }) })
	}

	// Every page's threads in page order, null until read.
	commentThreads(): readonly PdfCommentThread[] | null {
		if (this.threads === null) return null

		return [...this.threads.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, threads]) => threads)
	}

	// Reads the threads of `pages` (every page when null) again.
	private async readThreads(pages: readonly number[] | null): Promise<void> {
		const session = this.session

		if (session === null) return

		if (pages === null) this.threadsAsked = true

		const read = await session.engine.call("comments", pages === null ? {} : { pages }).catch(() => null)

		if (session !== this.session || read === null) {
			if (pages === null) this.threadsAsked = false

			return
		}

		const threads = new Map(pages === null ? [] : (this.threads ?? []))

		for (const page of pages ?? []) threads.delete(page)

		for (const thread of read) threads.set(thread.page, [...(threads.get(thread.page) ?? []), thread])

		this.threads = threads
		this.changed()
	}

	// --- Attachments ---

	openAttachments(open: boolean): void {
		this.set({ attachmentsOpen: open })
	}

	// The document's attachments, null while read (asked for here).
	attachments(): readonly PdfAttachmentInfo[] | null {
		const session = this.session

		if (this.attachmentList !== null || session === null) return this.attachmentList

		void session.engine.call("attachments", {}).then(
			list => {
				if (session !== this.session) return

				this.attachmentList = list
				this.changed()
			},
			() => undefined
		)

		return null
	}

	// --- The author, the ink drawing, the stamp picture, the hand, keys ---

	// The host's way of asking the author's name (the first annotation asks once).
	setAuthorAsk(ask: (() => Promise<string | null>) | null): void {
		this.askAuthor = ask
	}

	author(): Promise<string | null> {
		return this.askAuthor === null ? Promise.resolve("") : this.askAuthor()
	}

	// The drawing a stroke on `page` joins: the last one made, while the document is still at its revision.
	inkTarget(page: number, revision: number): number | null {
		const ink = this.ink

		return ink !== null && ink.page === page && ink.revision === revision ? ink.id : null
	}

	setInk(ink: { readonly page: number; readonly id: number; readonly revision: number } | null): void {
		this.ink = ink
	}

	setImage(image: PdfStampImage | null): void {
		this.set({ image, imageWanted: null })
	}

	wantImage(placement: PdfStampPlacement | null): void {
		this.set({ imageWanted: placement })
	}

	setHand(hand: boolean): void {
		if (hand !== this.state.hand) this.set({ hand })
	}

	// A page's overlay takes the keyboard placement keys of its page while its tool places by keyboard.
	listenKeys(page: number, listener: (key: ToolKey) => boolean): () => void {
		this.keys.set(page, listener)

		return () => {
			if (this.keys.get(page) === listener) this.keys.delete(page)
		}
	}

	key(page: number, key: ToolKey): boolean {
		return this.keys.get(page)?.(key) ?? false
	}
}

const stores = new WeakMap<PdfEditSwap, PdfAnnotationStore>()

// The store of an editing swap (one per opened PDF).
export function annotationStoreOf(swap: PdfEditSwap): PdfAnnotationStore {
	let store = stores.get(swap)

	if (store === undefined) {
		store = new PdfAnnotationStore()
		stores.set(swap, store)
	}

	return store
}

// The session the swap is editing, null before it is.
export function editingSession(swap: PdfEditSwap): PdfEditSessionModel | null {
	const phase = swap.getSnapshot()

	return phase.kind === "editing" ? phase.session : null
}
