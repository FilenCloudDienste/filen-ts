import type { PdfCommandResult, PdfEditState, PdfWidgetSummary } from "../../core/pdfedit/state"
import type { PdfCommandArgs, PdfCommandName } from "../../dom/pdfedit/commands/index"
import { PDF_STEP_WIDGET_PAGES, type PdfCommandOp, type PdfSaveEnded } from "../../dom/pdfedit/protocol"
import { MupdfPdfDocument, type PdfEditEngine } from "./mupdfDocument"

// An editing session on the page, headless: the engine's snapshot of the document, the widgets of the pages shown, and
// the document revision the page column draws. Every change goes through the engine (one at a time, in order); its
// answer brings the next snapshot and the touched pages' widgets, and the next document revision redraws exactly those
// pages. A view subscribes (useSyncExternalStore: subscribe / getSnapshot).

export interface PdfEditSnapshot {
	readonly document: MupdfPdfDocument
	readonly state: PdfEditState
	// Widgets of the pages read so far, by 0-based page.
	readonly widgets: ReadonlyMap<number, readonly PdfWidgetSummary[]>
	// Changes sent and not yet answered.
	readonly pending: number
	// The pages the change that made this revision of the document touched (every page after a save that started a
	// new history), for a view that reads more of a page than its rendering (its annotations).
	readonly touched: readonly number[]
}

export class PdfEditSessionModel {
	readonly engine: PdfEditEngine
	private snapshot: PdfEditSnapshot
	private readonly listeners = new Set<() => void>()
	// Pages whose widgets were asked for (answered or not).
	private readonly asked = new Set<number>()
	// Pages whose widgets are held, least recently read or shown first: an undo or redo reads again the latest of them
	// (the pages shown), so a shown page never goes without widgets and the cost stays bounded.
	private readonly held = new Set<number>()
	private wanted: number[] = []
	private flushing = false

	constructor(engine: PdfEditEngine, document: MupdfPdfDocument, state: PdfEditState) {
		this.engine = engine
		this.snapshot = { document, state, widgets: new Map(), pending: 0, touched: [] }
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	getSnapshot = (): PdfEditSnapshot => this.snapshot

	private set(next: PdfEditSnapshot): void {
		// Restrictions the owner password lifted no longer hold for printing either.
		this.snapshot = next.state.restrictions.owner ? { ...next, document: next.document.unrestricted() } : next

		for (const listener of this.listeners) listener()
	}

	private pending(delta: number): void {
		this.set({ ...this.snapshot, pending: this.snapshot.pending + delta })
	}

	// An answer: a newer snapshot replaces the held one, and the touched pages' widgets theirs.
	private apply(result: PdfCommandResult): void {
		const current = this.snapshot
		const widgets = new Map(current.widgets)

		const answered = new Set(result.widgets.map(entry => entry.page))

		for (const page of result.pages) {
			if (!answered.has(page)) {
				widgets.delete(page)
				this.asked.delete(page)
				this.held.delete(page)
			}
		}

		for (const entry of result.widgets) {
			widgets.set(entry.page, entry.widgets)
			this.hold(entry.page)
		}

		// Pages past a shortened document's end hold nothing.
		if (result.state.pageCount < current.state.pageCount) {
			for (const page of this.held) {
				if (page >= result.state.pageCount) {
					widgets.delete(page)
					this.asked.delete(page)
					this.held.delete(page)
				}
			}
		}

		this.set({
			document: current.document.next(result.pages, result.state.pageCount),
			state: result.state.revision >= current.state.revision ? result.state : current.state,
			widgets,
			pending: current.pending,
			touched: result.pages
		})
	}

	private hold(page: number): void {
		this.held.delete(page)
		this.held.add(page)
	}

	// The pages an undo or redo answers widgets for: the latest read or shown; the others are read again when they show.
	private shown(): number[] {
		return Array.from(this.held).slice(-PDF_STEP_WIDGET_PAGES)
	}

	private async run(call: () => Promise<PdfCommandResult>): Promise<PdfCommandResult> {
		this.pending(1)

		const result = await call().finally(() => {
			this.pending(-1)
		})

		this.apply(result)

		return result
	}

	// One command as one undo step; a gesture's steps share `op.id`, the last with `final`. `transfer` moves buffers in
	// `args` to the engine instead of copying them: the caller must not read them afterwards.
	dispatch<K extends PdfCommandName>(
		command: K,
		args: PdfCommandArgs[K],
		op?: PdfCommandOp,
		transfer?: Transferable[]
	): Promise<PdfCommandResult> {
		return this.run(() => this.engine.call("dispatch", { command, args, ...(op === undefined ? {} : { op }) }, transfer))
	}

	// `steps` back at once (one rebuild at most where the journal cannot take them back).
	undo(steps?: number): Promise<PdfCommandResult> {
		return this.run(() => this.engine.call("undo", { ...(steps === undefined ? {} : { steps }), pages: this.shown() }))
	}

	redo(): Promise<PdfCommandResult> {
		return this.run(() => this.engine.call("redo", { pages: this.shown() }))
	}

	// A snapshot from a request that is not a change (new protection chosen, owner rights unlocked).
	refresh(state: PdfEditState): void {
		if (state.revision >= this.snapshot.state.revision) this.set({ ...this.snapshot, state })
	}

	// A placed certificate signature that was not signed or not kept goes (signDiscard).
	discardSignature(): Promise<PdfCommandResult> {
		return this.run(() => this.engine.call("signDiscard", {}))
	}

	// The widgets of these pages, read once each (batched). A view calls it whenever its page shows: a held page is not
	// read again, only marked as the latest shown.
	want(pages: readonly number[]): void {
		for (const page of pages) {
			if (this.held.has(page)) {
				this.hold(page)
			} else if (!this.asked.has(page)) {
				this.asked.add(page)
				this.wanted.push(page)
			}
		}

		if (!this.flushing && this.wanted.length > 0) {
			this.flushing = true
			queueMicrotask(() => {
				void this.flush()
			})
		}
	}

	private async flush(): Promise<void> {
		const pages = this.wanted

		this.wanted = []
		this.flushing = false

		const read = await this.engine.call("widgets", { pages }).catch(() => null)

		if (read === null) {
			for (const page of pages) this.asked.delete(page)

			return
		}

		const widgets = new Map(this.snapshot.widgets)

		for (const entry of read) {
			widgets.set(entry.page, entry.widgets)
			this.hold(entry.page)
		}

		this.set({ ...this.snapshot, widgets })
	}

	// A save ended: its snapshot; a new history (the written file opened in place) redraws every page.
	saved(ended: PdfSaveEnded): void {
		const current = this.snapshot

		if (ended.history === "kept") {
			this.set({ ...current, state: ended.state })

			return
		}

		const all = Array.from({ length: ended.state.pageCount }, (_, index) => index)

		this.asked.clear()
		this.held.clear()
		this.set({
			document: current.document.next(all, ended.state.pageCount),
			state: ended.state,
			widgets: new Map(),
			pending: current.pending,
			touched: all
		})
	}
}
