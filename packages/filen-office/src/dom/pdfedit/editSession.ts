import type * as Mupdf from "mupdf"
import type { PdfMemoryProfile } from "../../core/pdfedit/budget"
import type { PdfSavePlan } from "../../core/pdfedit/savePlan"
import {
	PDF_UNRESTRICTED,
	toolAvailability,
	type PdfRestrictions,
	type PdfSignatureState,
	type PdfToolClass
} from "../../core/pdfedit/signaturePolicy"
import { heldAfterSave, type PdfHeldAccess, type PdfSecurityChoice, type PdfSecurityWriteOptions } from "../../core/pdfedit/security"
import type { PdfEditState, PdfFormState } from "../../core/pdfedit/state"
import { redactsContent } from "./commands/redact"
import { num } from "./fields"
import { formState, isTagged, signatureState, xfaState, type PdfRevisions } from "./formState"
import type { PdfAccess } from "./protocol"
import { securitySummary } from "./security/index"
import type { PdfStepKey } from "./stepKeys"
import type { SyncRangeLifetime } from "./syncRange"

// New protection chosen for the next save: the choice, and the write options planned from it (an encryption change).
export interface PendingSecurity {
	readonly choice: PdfSecurityChoice
	readonly options: Exclude<PdfSecurityWriteOptions, { readonly encrypt: "keep" }>
}

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
	// Per dispatch, the annotations it worked on and made, by name (stepKeys.ts): its arguments' object numbers do not
	// hold when it runs again.
	readonly keys: readonly PdfStepKey[]
	// What its dispatches added to the document (PdfCommand.bytes).
	readonly bytes: number
}

// One dispatch as the history takes it.
export interface PdfDispatched {
	readonly tool: PdfToolClass
	readonly label: string
	readonly args: unknown
	readonly key: PdfStepKey
	readonly bytes: number
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
	// The new protection it was written with, and MuPDF's name for the encryption it has.
	readonly security: PendingSecurity | null
	readonly encryption: string
	// It redacted, changed the protection or invalidated signatures: once it becomes the file, the session starts again
	// on it.
	readonly resets: boolean
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
	// The last save rewrote the file and the document went on on the one it read before (its history kept): the drive
	// holds the rewrite, so nothing may be appended to the document's own file (an incremental save would bring back
	// what the rewrite left out).
	fileBehind = false
	// The document reads a file a save here wrote (PdfEditState.ownFile).
	ownFile = false
	signatures: PdfSignatureState
	restrictions: PdfRestrictions
	form: PdfFormState
	tagged: boolean
	encryption: string
	access: PdfAccess
	// The password the document was opened with (or the owner password that unlocked it later): a rebuild opens it
	// again. Held in the engine's memory only.
	password: string | undefined
	// What the document is authenticated with (security.ts PdfHeldAccess), in the engine's memory only.
	held: PdfHeldAccess
	// The protection the next save writes (the Protect dialog's choice, planned), null: the file keeps its own.
	security: PendingSecurity | null = null
	// The engine's memory profile, and the size of the file as last written (opened, or saved here).
	readonly memory: PdfMemoryProfile
	fileBytes: number
	private pages: Map<number, number> | null = null
	// The operation still open (a gesture continues it): its gesture id, its step, and the journal position before it.
	private open: { readonly id: string | null; readonly step: LoggedStep; readonly before: number } | null = null

	constructor(
		document: Mupdf.PDFDocument,
		options: {
			readonly access: PdfAccess
			readonly encryption: string
			readonly restrictions: PdfRestrictions
			readonly held: PdfHeldAccess
			readonly password?: string
			// The file the document reads, for the revisions its signatures signed.
			readonly revisions: PdfRevisions
			readonly memory: PdfMemoryProfile
			readonly fileBytes: number
		}
	) {
		this.signatures = signatureState(document, options.revisions)
		this.form = formState(document)
		this.tagged = isTagged(document)
		this.access = options.access
		this.encryption = options.encryption
		this.restrictions = options.restrictions
		this.held = options.held
		this.password = options.password
		this.memory = options.memory
		this.fileBytes = options.fileBytes
	}

	// Starts a command's operation, or continues the gesture's (same id) still open; any other open one ends first.
	begin(document: Mupdf.PDFDocument, dispatched: PdfDispatched, gesture: string | null): void {
		if (this.open !== null && (gesture === null || this.open.id !== gesture)) this.endOpen(document)

		const { tool, label, args, key, bytes } = dispatched

		if (this.open !== null) {
			const { step } = this.open

			this.open = {
				...this.open,
				step: { ...step, args: [...step.args, args], keys: [...step.keys, key], bytes: step.bytes + bytes }
			}

			return
		}

		// MuPDF cannot report its journal's position while an operation is open: read before it begins.
		const before = document.getJournal().position

		document.beginOperation(label)
		this.open = { id: gesture, step: { tool, label, args: [args], keys: [key], bytes }, before }
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

	// `steps` back (at least one). `rebuild(count)` replaces the document with the opened file plus the first `count`
	// steps: once, for whatever the journal cannot take back.
	undo(document: Mupdf.PDFDocument, rebuild: (count: number) => void, steps = 1): void {
		const target = Math.max(0, this.applied - Math.max(1, steps))

		if (target === this.applied) return

		if (target >= this.journalBase) {
			while (this.applied > target && document.canUndo()) {
				document.undo()
				this.applied--
				this.journalRedo = true
			}
		}

		if (this.applied > target) {
			rebuild(target)
			this.applied = target
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
		if (this.security !== null) kinds.add("security")

		return [...kinds]
	}

	// The steps in the document, as the save writes it (an open gesture's ends before a save).
	appliedSteps(): readonly LoggedStep[] {
		return this.log.slice(0, this.applied)
	}

	// The bytes the steps in the document added since its file was last written (all of them when that state is gone),
	// the open gesture's included.
	addedBytes(): number {
		let total = this.open?.step.bytes ?? 0

		for (let index = this.savedApplied < 0 ? 0 : Math.min(this.savedApplied, this.applied); index < this.applied; index++)
			total += this.log[index]?.bytes ?? 0

		return total
	}

	// The owner password unlocked the document: its restrictions are lifted, and a rebuild opens it with that password.
	unlocked(held: PdfHeldAccess): void {
		this.held = held
		this.password = held.password
		this.access = "owner"
		this.restrictions = PDF_UNRESTRICTED
		this.revision++
	}

	// Sets the protection the next save writes (null: none of its own).
	protect(security: PendingSecurity | null): void {
		this.security = security
		this.revision++
	}

	// A save wrote new protection and became the file: the document carries it now, with owner rights (the user chose
	// the owner password). `method`: MuPDF's name for it.
	protectedAs(options: PdfSecurityWriteOptions, method: string): void {
		this.held = heldAfterSave(options, this.held)
		this.password = this.held.password === "" ? undefined : this.held.password
		this.encryption = method
		this.access = options.encrypt === "none" ? "none" : "owner"
		this.restrictions = PDF_UNRESTRICTED
		this.security = null
		this.revision++
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
	reset(document: Mupdf.PDFDocument, revisions: PdfRevisions): void {
		this.log = []
		this.applied = 0
		this.savedApplied = 0
		this.journalBase = 0
		this.journalRedo = false
		this.open = null
		this.pages = null
		this.signatures = signatureState(document, revisions)
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
			// New protection is a change to save too.
			dirty: this.applied !== this.savedApplied || this.open !== null || this.security !== null,
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
			security: { ...securitySummary(document, this.held), pending: this.security?.choice.kind ?? null },
			redacting: redactsContent(this.appliedSteps()),
			ownFile: this.ownFile,
			tagged: this.tagged,
			// XFA read live: removing it before a save is a step that undo takes back.
			form: { ...this.form, xfa: xfaState(document) }
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
