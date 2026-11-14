import type * as Mupdf from "mupdf"
import type { PdfSavePlan } from "../../core/pdfedit/savePlan"
import {
	PDF_UNRESTRICTED,
	toolAvailability,
	type PdfRestrictions,
	type PdfSignatureState,
	type PdfToolClass
} from "../../core/pdfedit/signaturePolicy"
import type { PdfEditState, PdfFormState } from "../../core/pdfedit/state"
import { num } from "./fields"
import { formState, isTagged, signatureState } from "./formState"
import type { PdfAccess } from "./protocol"
import type { SyncRangeLifetime } from "./syncRange"

// The editor's history and bookkeeping. Every change is a command, logged with its arguments, and run as one MuPDF
// journal operation. Undo and redo go through MuPDF's journal while they can; a save ends that (MuPDF 1.28 cannot undo
// a step made before a write: it moves its position and changes nothing), so a step back past a save rebuilds the
// document instead: the file as the session opened it, with the logged commands before that step run again (the
// caller's `rebuild`). Redoing a step the journal cannot redo runs its command again. Dirty is any number of applied
// steps other than the last save's.

export interface LoggedStep {
	readonly tool: PdfToolClass
	// The command's name, its journal label.
	readonly label: string
	// The arguments of each dispatch the step was made of (a gesture's several).
	readonly args: readonly unknown[]
}

// A lifetime the engine ends itself (an AbortSignal's shape, without the DOM).
export class EngineLifetime implements SyncRangeLifetime {
	aborted = false
	private readonly listeners: (() => void)[] = []

	addEventListener(_type: "abort", listener: () => void): void {
		if (this.aborted) listener()
		else this.listeners.push(listener)
	}

	abort(): void {
		if (this.aborted) return

		this.aborted = true

		for (const listener of this.listeners.splice(0)) listener()
	}
}

export interface HeldOutput {
	readonly buffer: Mupdf.Buffer
	readonly plan: PdfSavePlan
	readonly serving: EngineLifetime[]
	// The applied count the file's last save stands at again when this save does not become the file.
	readonly previousSaved: number
}

// Runs one logged step on `document` as one journal operation.
export type PdfStepRunner = (document: Mupdf.PDFDocument, step: LoggedStep) => void

export class PdfEditSession {
	revision = 0
	// Every step made, in order: the first `applied` are in the document, the rest can be redone.
	log: LoggedStep[] = []
	applied = 0
	// The applied count of the last save (or the open); -1 when that state can no longer be reached.
	savedApplied = 0
	// Steps before this count were made before the document's last write: the journal cannot undo them.
	journalBase = 0
	// The steps after `applied` were undone through the journal since its last write, which can redo them.
	journalRedo = false
	output: HeldOutput | null = null
	signatures: PdfSignatureState
	restrictions: PdfRestrictions
	form: PdfFormState
	tagged: boolean
	readonly encryption: string
	readonly access: PdfAccess
	// The password the document was opened with: a rebuild opens it again. Held in the engine's memory only.
	readonly password: string | undefined
	private pages: Map<number, number> | null = null
	// The operation still open (a gesture continues it): its gesture id, its step, and the journal position before it.
	private open: { readonly id: string | null; readonly step: LoggedStep; readonly before: number } | null = null

	constructor(
		document: Mupdf.PDFDocument,
		options: {
			readonly access: PdfAccess
			readonly encryption: string
			readonly restrictions: PdfRestrictions
			readonly password?: string
		}
	) {
		this.signatures = signatureState(document)
		this.form = formState(document)
		this.tagged = isTagged(document)
		this.access = options.access
		this.encryption = options.encryption
		this.restrictions = options.restrictions
		this.password = options.password
	}

	// Starts a command's operation, or continues the gesture's (same id) still open; any other open one ends first.
	begin(document: Mupdf.PDFDocument, label: string, tool: PdfToolClass, args: unknown, gesture: string | null): void {
		if (this.open !== null && (gesture === null || this.open.id !== gesture)) this.endOpen(document)

		if (this.open !== null) {
			this.open = { ...this.open, step: { ...this.open.step, args: [...this.open.step.args, args] } }

			return
		}

		// MuPDF cannot report its journal's position while an operation is open: read before it begins.
		const before = document.getJournal().position

		document.beginOperation(label)
		this.open = { id: gesture, step: { tool, label, args: [args] }, before }
	}

	// The command ran: its operation ends, unless a gesture continues it (`final` false).
	finish(document: Mupdf.PDFDocument, final: boolean): void {
		if (final) this.endOpen(document)
		else this.revision++
	}

	// The command failed: its operation (with a gesture's earlier steps) is rolled back.
	fail(document: Mupdf.PDFDocument): void {
		if (this.open === null) return

		this.open = null
		document.abandonOperation()
		this.revision++
	}

	// Ends the operation still open. One that changed nothing is no step.
	endOpen(document: Mupdf.PDFDocument): void {
		const open = this.open

		if (open === null) return

		this.open = null
		document.endOperation()

		if (document.getJournal().position > open.before) {
			// A new step: the steps after it (the redo history) are gone.
			this.log.length = this.applied
			this.log.push(open.step)

			if (this.savedApplied > this.applied) this.savedApplied = -1

			this.applied++
			this.journalRedo = false
		}

		this.revision++
	}

	// A write of the document happened (a save, whatever became of it): the journal cannot undo across it.
	written(): void {
		this.journalBase = this.applied
		this.journalRedo = false
		this.revision++
	}

	// One step back. `rebuild(count)` replaces the document with the opened file plus the first `count` steps.
	undo(document: Mupdf.PDFDocument, rebuild: (count: number) => void): void {
		if (this.applied === 0) return

		if (this.applied > this.journalBase && document.canUndo()) {
			document.undo()
			this.applied--
			this.journalRedo = true
		} else {
			rebuild(this.applied - 1)
			this.applied--
			this.journalBase = 0
			this.journalRedo = false
		}

		this.revision++
	}

	// One step forward: through the journal when it holds it, else by running the step's command again.
	redo(document: Mupdf.PDFDocument, run: PdfStepRunner): void {
		const step = this.log[this.applied]

		if (step === undefined) return

		if (this.journalRedo && document.canRedo()) document.redo()
		else {
			run(document, step)
			this.journalRedo = false
		}

		this.applied++
		this.revision++
	}

	// Kinds of change made since opening, as the document stands (undone steps are not).
	changes(): PdfToolClass[] {
		const kinds = new Set<PdfToolClass>()

		for (let index = 0; index < this.applied; index++) {
			const step = this.log[index]

			if (step !== undefined) kinds.add(step.tool)
		}

		if (this.open !== null) kinds.add(this.open.step.tool)

		return [...kinds]
	}

	// The 0-based page of a page object, from one walk of the page tree kept until pages change.
	pageOf(document: Mupdf.PDFDocument, pageObject: number): number | undefined {
		if (this.pages === null) {
			const pages = new Map<number, number>()
			const count = document.countPages()

			for (let index = 0; index < count; index++) {
				const object = num(document.findPage(index))

				if (object !== null) pages.set(object, index)
			}

			this.pages = pages
		}

		return this.pages.get(pageObject)
	}

	pagesChanged(): void {
		this.pages = null
	}

	// Drops a held save (the document closes).
	close(): void {
		const output = this.output

		this.output = null

		if (output === null) return

		for (const lifetime of output.serving) lifetime.abort()

		output.buffer.destroy()
	}

	// The document was replaced by a written file: everything is read again and the history starts over.
	reset(document: Mupdf.PDFDocument): void {
		this.log = []
		this.applied = 0
		this.savedApplied = 0
		this.journalBase = 0
		this.journalRedo = false
		this.open = null
		this.pages = null
		this.signatures = signatureState(document)
		this.form = formState(document)
		this.tagged = isTagged(document)
		this.revision++
	}

	snapshot(document: Mupdf.PDFDocument): PdfEditState {
		// An open gesture is the step undo takes back (its operation ends first), and redo has nothing then.
		const undo = this.open?.step ?? this.log[this.applied - 1] ?? null
		const redo = this.open === null ? (this.log[this.applied] ?? null) : null

		return {
			revision: this.revision,
			pageCount: document.countPages(),
			dirty: this.applied !== this.savedApplied || this.open !== null,
			canUndo: undo !== null,
			canRedo: redo !== null,
			undoLabel: undo?.label ?? null,
			redoLabel: redo?.label ?? null,
			changes: this.changes(),
			versions: document.countVersions(),
			signatures: this.signatures,
			restrictions: this.restrictions,
			tools: toolAvailability(this.signatures, this.restrictions),
			encryption: { method: this.encryption, access: this.access },
			tagged: this.tagged,
			form: this.form
		}
	}
}

// An unencrypted document has no restrictions (its permissions would only be advisory flags no password guards), nor
// one the owner password unlocked.
export function restrictionsOf(permissions: Readonly<Record<string, boolean>>, access: PdfAccess, encryption: string): PdfRestrictions {
	if (access === "owner" || encryption === "None") return PDF_UNRESTRICTED

	return {
		owner: false,
		print: permissions["print"] === true,
		edit: permissions["edit"] === true,
		annotate: permissions["annotate"] === true,
		form: permissions["form"] === true,
		assemble: permissions["assemble"] === true
	}
}
