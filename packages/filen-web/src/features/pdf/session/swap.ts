import { PDF_TILE_DESKTOP, PDF_TILE_MOBILE } from "@filen/office/dom/pdfedit"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { MupdfPdfDocument, PdfEditSessionModel, readPdfDocumentFacts, type PdfDocumentFacts } from "@filen/office/react/pdfedit"
import type { AnyFile } from "@filen/sdk-rs"
import type { PdfEngine } from "@/features/pdf/session/engineWorker"
import { prefetchPdfEngine } from "@/features/pdf/session/engineModule"
import { log } from "@/lib/log"

// The silent swap from the viewer (pdf.js) to the editor (MuPDF in its worker). The first change asks for the editor:
// the engine starts (its wasm usually prefetched), opens the file ranged with the password the viewer accepted, and
// the change runs once it is ready, followed by any made meanwhile, in order. The viewer keeps showing pdf.js until
// then and hands its page column to the editor's document (react/pdfedit), keeping page, zoom, scroll and the painted
// pages. A failure to start leaves the viewer as it was ("failed", with a retry); a poisoned engine is gone with its
// unsaved changes, and the viewer goes back to pdf.js on the file ("poisoned").

export type PdfEditPhase =
	| { readonly kind: "view" }
	| { readonly kind: "starting" }
	| { readonly kind: "editing"; readonly engine: PdfEngine; readonly session: PdfEditSessionModel; readonly startedMs: number }
	| { readonly kind: "failed" }
	| { readonly kind: "poisoned" }

export interface PdfSwapDeps {
	// Opens the editing engine on `file`; `onPoisoned` once if it is poisoned.
	open(file: AnyFile, password: string | undefined, onPoisoned: (message: string) => void): Promise<PdfEngine>
	mobile: boolean
	// A change the engine refused (shown to the user).
	onChangeFailed(error: unknown): void
}

type Change = (session: PdfEditSessionModel) => Promise<unknown>

export class PdfEditSwap {
	private phase: PdfEditPhase = { kind: "view" }
	private readonly listeners = new Set<() => void>()
	private readonly deps: PdfSwapDeps
	private queue: Change[] = []
	private running: Promise<void> = Promise.resolve()
	// The viewer's document (what it knows that the engine does not serve is read from it before it closes) and the
	// password it accepted (memory only, for the engine's open).
	private viewer: PdfDomDocument | null = null
	private file: AnyFile | null = null
	private accepted: string | undefined
	private generation = 0

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

	private facts(): Promise<PdfDocumentFacts> {
		return this.viewer === null
			? Promise.resolve({ info: null, permissions: null, signatures: null, outline: null })
			: readPdfDocumentFacts(this.viewer)
	}

	// Fetches and compiles the engine ahead of its first use.
	prefetch(): void {
		prefetchPdfEngine()
	}

	// Runs `change` on the editor, starting it first if needed.
	edit(change: Change): void {
		const phase = this.phase

		if (phase.kind === "poisoned") return

		this.queue.push(change)

		if (phase.kind === "editing") this.drain(phase.session)
		else if (phase.kind !== "starting") void this.start()
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
		if (this.phase.kind === "failed") void this.start()
	}

	private async start(): Promise<void> {
		const generation = ++this.generation
		const started = performance.now()

		this.set({ kind: "starting" })

		const opened = await this.open(generation).catch((error: unknown) => {
			log.warn("pdf", "the editor did not start", { error })

			return null
		})

		if (generation !== this.generation) {
			void opened?.engine.close()

			return
		}

		if (opened === null) {
			this.queue = []
			this.set({ kind: "failed" })

			return
		}

		const startedMs = performance.now() - started

		log.info("pdf", "editor ready", { startedMs: Math.round(startedMs) })
		this.set({ kind: "editing", engine: opened.engine, session: opened.session, startedMs })
		this.drain(opened.session)
	}

	private async open(generation: number): Promise<{ readonly engine: PdfEngine; readonly session: PdfEditSessionModel }> {
		const file = this.file

		if (file === null) throw new Error("no file to edit")

		const [engine, facts] = await Promise.all([
			this.deps.open(file, this.accepted, () => {
				if (generation === this.generation) this.poisoned()
			}),
			this.facts()
		])

		if (engine.opened.status !== "open") {
			void engine.close()

			throw new Error("the editor could not unlock the document")
		}

		const state = await engine.client.call("state", {})
		const document = MupdfPdfDocument.open(engine.client, {
			pageCount: state.pageCount,
			tileSize: this.deps.mobile ? PDF_TILE_MOBILE : PDF_TILE_DESKTOP,
			facts
		})

		return { engine, session: new PdfEditSessionModel(engine.client, document, state) }
	}

	// Changes run one after another; one the engine refuses is reported and the next runs.
	private drain(session: PdfEditSessionModel): void {
		const changes = this.queue

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
		this.queue = []
		this.set({ kind: "poisoned" })
	}

	// Back to the viewer: the engine closes with whatever is unsaved (Discard), or the viewer was closed.
	close(): void {
		const phase = this.phase

		this.generation++
		this.queue = []

		if (phase.kind === "editing") void phase.engine.close()

		this.set({ kind: "view" })
	}

	// The engine is replaced by a fresh one on the file a save made (its heap returns to the working set; the history
	// starts again). Open on `open`, which reads the new file.
	async respawn(open: (password: string | undefined, onPoisoned: (message: string) => void) => Promise<PdfEngine>): Promise<void> {
		const phase = this.phase

		if (phase.kind !== "editing") return

		const generation = ++this.generation
		const facts = phase.session.getSnapshot().document.facts

		void phase.engine.close()

		const engine = await open(this.accepted, () => {
			if (generation === this.generation) this.poisoned()
		}).catch(() => null)

		if (generation !== this.generation) return

		if (engine?.opened.status !== "open") {
			void engine?.close()
			this.set({ kind: "poisoned" })

			return
		}

		const state = await engine.client.call("state", {})
		const document = MupdfPdfDocument.open(engine.client, {
			pageCount: state.pageCount,
			tileSize: this.deps.mobile ? PDF_TILE_MOBILE : PDF_TILE_DESKTOP,
			facts
		})

		this.set({ kind: "editing", engine, session: new PdfEditSessionModel(engine.client, document, state), startedMs: phase.startedMs })
	}
}
