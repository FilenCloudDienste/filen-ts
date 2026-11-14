import { PDF_TILE_DESKTOP, PDF_TILE_MOBILE } from "@filen/office/dom/pdfedit"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import {
	engineDocumentPermissions,
	MupdfPdfDocument,
	PdfEditSessionModel,
	readPdfDocumentFacts,
	type PdfDocumentFacts
} from "@filen/office/react/pdfedit"
import type { AnyFile } from "@filen/sdk-rs"
import type { PdfEngine } from "@/features/pdf/session/engineWorker"
import { prefetchPdfEngine, prefetchPdfEngineIdle } from "@/features/pdf/session/engineModule"
import { log } from "@/lib/log"

// The silent swap from the viewer (pdf.js) to the editor (MuPDF in its worker). The first change asks for the editor:
// the engine starts (its wasm usually prefetched), opens the file ranged with the password the viewer accepted, and
// the change runs once it is ready, followed by any made meanwhile, in order. The viewer keeps showing pdf.js until
// then and hands its page column to the editor's document (react/pdfedit), keeping page, zoom, scroll and the painted
// pages. A failure to start leaves the viewer as it was ("failed", with a retry); a poisoned engine is gone with its
// unsaved changes, and the viewer goes back to pdf.js on the file ("poisoned"). While a save holds the document (the
// engine refuses changes until it ends, a fresh engine opening on the saved file included) changes wait, and run after
// it in order; a fresh engine that does not open leaves the saved file in the viewer ("reopenFailed", with a retry
// that keeps those changes).

export type PdfEditPhase =
	| { readonly kind: "view" }
	| { readonly kind: "starting" }
	| {
			readonly kind: "editing"
			readonly engine: PdfEngine
			readonly session: PdfEditSessionModel
			readonly startedMs: number
			// The engine was opened on a file a save here wrote (a respawn), which the viewer's parser never read.
			readonly respawned: boolean
			// A save holds the document: changes wait for it.
			readonly saving: boolean
	  }
	| { readonly kind: "failed" }
	| { readonly kind: "poisoned" }
	// A save made the file, and the fresh engine meant to go on on it did not open.
	| { readonly kind: "reopenFailed" }

export type PdfEngineOpener = (password: string | undefined, onPoisoned: (message: string) => void) => Promise<PdfEngine>

export interface PdfSwapDeps {
	// Opens the editing engine on `file`; `onPoisoned` once if it is poisoned.
	open(file: AnyFile, password: string | undefined, onPoisoned: (message: string) => void): Promise<PdfEngine>
	mobile: boolean
	// A change the engine refused (shown to the user).
	onChangeFailed(error: unknown): void
}

type Change = (session: PdfEditSessionModel) => Promise<unknown>

// A change waiting for the editor, and who hears when it is dropped instead (the editor did not start, was poisoned or
// closed first).
interface Queued {
	readonly change: Change
	readonly dropped: (() => void) | undefined
}

interface Opened {
	readonly engine: PdfEngine
	readonly session: PdfEditSessionModel
}

export class PdfEditSwap {
	private phase: PdfEditPhase = { kind: "view" }
	private readonly listeners = new Set<() => void>()
	private readonly deps: PdfSwapDeps
	private queue: Queued[] = []
	private running: Promise<void> = Promise.resolve()
	// The viewer's document (what it knows that the engine does not serve is read from it before it closes) and the
	// password it accepted (memory only, for the engine's open).
	private viewer: PdfDomDocument | null = null
	private file: AnyFile | null = null
	private accepted: string | undefined
	private generation = 0
	// The saves holding the document now (each releases its own).
	private readonly holds = new Set<object>()
	// What a retry after "reopenFailed" opens (the saved file), and the facts it keeps.
	private reopen: { readonly open: PdfEngineOpener; readonly facts: Omit<PdfDocumentFacts, "permissions"> } | null = null

	constructor(deps: PdfSwapDeps) {
		this.deps = deps
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	getSnapshot = (): PdfEditPhase => this.phase

	private set(phase: PdfEditPhase): void {
		this.phase = phase

		for (const listener of this.listeners) listener()
	}

	// The file the editor opens (the slot's current version).
	setFile(file: AnyFile): void {
		this.file = file
	}

	// The viewer's document shown now, or null when it went.
	setViewer(document: PdfDomDocument | null, password: string | null): void {
		this.viewer = document
		this.accepted = password ?? undefined
	}

	// The password the document opens with (a verifying engine opens a written file with it too).
	password(): string | undefined {
		return this.accepted
	}

	// The document opens with another password from now on: the owner password that unlocked it, or the new one a save
	// protected it with (undefined: it has none).
	setPassword(password: string | undefined): void {
		this.accepted = password
	}

	private facts(): Promise<Omit<PdfDocumentFacts, "permissions">> {
		return this.viewer === null ? Promise.resolve({ info: null, signatures: null, outline: null }) : readPdfDocumentFacts(this.viewer)
	}

	// Fetches and compiles the engine ahead of its first use.
	prefetch(): void {
		prefetchPdfEngine()
	}

	// The same while the reader is idle, as far as the device allows (prefetchPdfEngineIdle).
	prefetchIdle(): void {
		prefetchPdfEngineIdle()
	}

	// Runs `change` on the editor, starting it first if needed; `dropped` runs instead when it never will.
	edit(change: Change, dropped?: () => void): void {
		const phase = this.phase

		if (phase.kind === "poisoned") {
			dropped?.()

			return
		}

		this.queue.push({ change, dropped })

		if (phase.kind === "editing") {
			if (this.holds.size === 0) this.drain(phase.session)
		} else if (phase.kind !== "starting") void this.start()
	}

	// A save holds the document until the returned release (called once, any way it ends): changes wait meanwhile, then
	// run in order on whichever session the save left.
	hold(): () => void {
		const token = {}

		this.holds.add(token)
		this.savingChanged()

		return () => {
			if (!this.holds.delete(token)) return

			this.savingChanged()

			if (this.holds.size === 0 && this.phase.kind === "editing") this.drain(this.phase.session)
		}
	}

	private savingChanged(): void {
		const phase = this.phase
		const saving = this.holds.size > 0

		if (phase.kind === "editing" && phase.saving !== saving) this.set({ ...phase, saving })
	}

	// Starts the editor ahead of a change about to come (the first key typed into a field: its edit commits later).
	warm(): void {
		if (this.phase.kind === "view") void this.start()
	}

	// Runs `apply` on the session when the editor already has the document; never starts it.
	withSession(apply: (session: PdfEditSessionModel) => void): void {
		if (this.phase.kind === "editing") apply(this.phase.session)
	}

	retry(): void {
		if (this.phase.kind === "failed" || this.phase.kind === "reopenFailed") void this.start()
	}

	private async start(): Promise<void> {
		const generation = ++this.generation
		const started = performance.now()
		const reopen = this.reopen

		this.set({ kind: "starting" })

		const opened = await (reopen === null ? this.open(generation) : this.openOn(generation, reopen.open, reopen.facts)).catch(
			(error: unknown) => {
				log.warn("pdf", "the editor did not start", { error })

				return null
			}
		)

		if (generation !== this.generation) {
			void opened?.engine.close()

			return
		}

		if (opened === null) {
			// A retry of a reopen keeps the changes made since the save for the next one.
			if (reopen === null) {
				this.drop()
				this.set({ kind: "failed" })
			} else this.set({ kind: "reopenFailed" })

			return
		}

		const startedMs = performance.now() - started

		this.reopen = null
		log.info("pdf", "editor ready", { startedMs: Math.round(startedMs) })
		this.set({ kind: "editing", ...opened, startedMs, respawned: reopen !== null, saving: this.holds.size > 0 })

		if (this.holds.size === 0) this.drain(opened.session)
	}

	private async open(generation: number): Promise<Opened> {
		const file = this.file

		if (file === null) throw new Error("no file to edit")

		const [engine, facts] = await Promise.all([this.deps.open(file, this.accepted, this.onPoisoned(generation)), this.facts()])

		return this.ready(engine, facts)
	}

	private async openOn(generation: number, open: PdfEngineOpener, facts: Omit<PdfDocumentFacts, "permissions">): Promise<Opened> {
		return this.ready(await open(this.accepted, this.onPoisoned(generation)), facts)
	}

	private onPoisoned(generation: number): (message: string) => void {
		return () => {
			if (generation === this.generation) this.poisoned()
		}
	}

	// The session on an opened engine (closed when it cannot be had). The document's restrictions are the engine's
	// reading of the file it opened, with the password it holds (a protection a save changed included).
	private async ready(engine: PdfEngine, facts: Omit<PdfDocumentFacts, "permissions">): Promise<Opened> {
		try {
			if (engine.opened.status !== "open") throw new Error("the editor could not unlock the document")

			const permissions = engineDocumentPermissions(engine.opened)
			const state = await engine.client.call("state", {})
			const document = MupdfPdfDocument.open(engine.client, {
				pageCount: state.pageCount,
				tileSize: this.deps.mobile ? PDF_TILE_MOBILE : PDF_TILE_DESKTOP,
				facts: { ...facts, permissions }
			})

			return { engine, session: new PdfEditSessionModel(engine.client, document, state) }
		} catch (error) {
			void engine.close()

			throw error
		}
	}

	// Changes that will not run now: each waiting one's caller hears it.
	private drop(): void {
		for (const queued of this.queue.splice(0)) queued.dropped?.()
	}

	// Changes run one after another; one the engine refuses is reported and the next runs.
	private drain(session: PdfEditSessionModel): void {
		const changes = this.queue.map(queued => queued.change)

		this.queue = []

		for (const change of changes) {
			this.running = this.running.then(() =>
				change(session).then(
					() => undefined,
					(error: unknown) => {
						this.deps.onChangeFailed(error)
					}
				)
			)
		}
	}

	private poisoned(): void {
		this.generation++
		this.reopen = null
		this.drop()
		this.set({ kind: "poisoned" })
	}

	// Back to the viewer: the engine closes with whatever is unsaved (Discard), or the viewer was closed.
	close(): void {
		const phase = this.phase

		this.generation++
		this.reopen = null
		this.holds.clear()
		this.drop()

		if (phase.kind === "editing") void phase.engine.close()

		this.set({ kind: "view" })
	}

	// The engine is replaced by a fresh one on the file a save made (its heap returns to the working set; the history
	// starts again), opened by `open`, which reads the new file. True once it has the document; false when it did not
	// open (the phase says "reopenFailed", and a retry opens it again) or the editor went meanwhile.
	async respawn(open: PdfEngineOpener): Promise<boolean> {
		const phase = this.phase

		if (phase.kind !== "editing") return false

		const generation = ++this.generation
		const { facts } = phase.session.getSnapshot().document
		const kept = { info: facts.info, signatures: facts.signatures, outline: facts.outline }

		void phase.engine.close()

		const opened = await this.openOn(generation, open, kept).catch((error: unknown) => {
			log.warn("pdf", "the editor did not open the saved file", { error })

			return null
		})

		if (generation !== this.generation) {
			void opened?.engine.close()

			return false
		}

		if (opened === null) {
			this.reopen = { open, facts: kept }
			this.set({ kind: "reopenFailed" })

			return false
		}

		this.set({ kind: "editing", ...opened, startedMs: phase.startedMs, respawned: true, saving: this.holds.size > 0 })

		if (this.holds.size === 0) this.drain(opened.session)

		return true
	}
}
