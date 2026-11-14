import type * as Mupdf from "mupdf"
import { savePortWriter, type SavePortEnd } from "@filen/shared/savePort"
import { fitsEdit, type PdfMemoryProfile } from "../../core/pdfedit/budget"
import { REDACTION_SAVE_OPTIONS } from "../../core/pdfedit/redactVerify"
import { planSave } from "../../core/pdfedit/savePlan"
import {
	composeWriteOptions,
	passwordCandidates,
	PDF_AES256_METHOD,
	PDF_AUTH_OWNER,
	PDF_AUTH_USER,
	type PdfHeldAccess
} from "../../core/pdfedit/security"
import type { PdfCommandResult, PdfPageWidgets } from "../../core/pdfedit/state"
import { saslPrepPassword } from "../../core/pdfwrite/crypto"
import { pdfCommand, redactionManifest } from "./commands/index"
import { isIndex, isRecord, outcomePages, type PdfCommand, type PdfCommandContext, type PdfCommandOutcome } from "./commands/types"
import { pendingSignature } from "./commands/sign"
import { PdfEngineRefusal, type OpenDocument, type PdfEngineContext } from "./context"
import { EngineLifetime, PdfEditSession, restrictionsOf, type LoggedStep, type PendingSecurity } from "./editSession"
import { pageWidgets, type PdfRevisions } from "./formState"
import type { PdfOpenResult, PdfSaveProtection } from "./protocol"
import type { PdfRequestHandler } from "./requests"
import { TileRenderer } from "./render"
import { syncRangeStreamHandle } from "./stream"
import { nameCreated, resolveTarget, targetKey, type PdfStepKey } from "./stepKeys"
import { serveSyncRange } from "./syncRange"
import { fileRevisions } from "./verifyRequest"
import { pageTextLines, pageTextLinks, pointOf } from "./text"

// The edit role's requests: commands as journal operations, undo and redo, the snapshot the page holds, and the save
// path. A save is planned, written into the heap (saveToBuffer), served from there to a second, short-lived engine that
// checks it (serveOutput, checkSaved there), streamed to the upload over a save port (writeOutput), and ended
// (saveEnd): the session goes on on the same document, its history kept, or on the written file opened in place.
// Nothing leaves the heap until the check passed; a failed check or upload leaves the document and its history as they
// were.

// Most bytes one save port write takes from the heap at once.
const OUTPUT_SLICE = 4 * 1024 * 1024

type EditOp =
	| "state"
	| "widgets"
	| "dispatch"
	| "undo"
	| "redo"
	| "saveBegin"
	| "serveOutput"
	| "writeOutput"
	| "saveEnd"
	| "text"
	| "destination"
	| "checkSaved"

type Handlers = { readonly [K in EditOp]: PdfRequestHandler<K> }

export type Editing = OpenDocument & { readonly edit: PdfEditSession }

// Starts the editor's bookkeeping on an unlocked document: the journal from here on.
export function startEdit(
	document: Mupdf.PDFDocument,
	opened: Extract<PdfOpenResult, { status: "open" }>,
	password: string | undefined,
	revisions: PdfRevisions,
	memory: PdfMemoryProfile,
	fileBytes: number
): PdfEditSession {
	document.enableJournal()

	const { encryption, permissions } = opened.document

	return new PdfEditSession(document, {
		access: opened.access,
		encryption,
		restrictions: restrictionsOf(permissions, opened.access, encryption),
		held: heldAtStart(document, opened, password),
		revisions,
		...(password === undefined ? {} : { password }),
		memory,
		fileBytes
	})
}

// What the just unlocked document is authenticated with: the candidate of `password` that unlocks it (each attempt
// authenticates anew, so the last one tried is the one that holds), or the empty password of a document that opens
// without one.
function heldAtStart(
	document: Mupdf.PDFDocument,
	opened: Extract<PdfOpenResult, { status: "open" }>,
	password: string | undefined
): PdfHeldAccess {
	if (opened.document.encryption === "None") return { password: "", bits: 0, openPassword: false }
	if (opened.access === "none" || password === undefined)
		return { password: "", bits: document.authenticatePassword(""), openPassword: false }

	// Whether the file opens without a password (an owner password may have unlocked one that does); the candidates
	// below authenticate again either way.
	const openPassword = document.authenticatePassword("") === 0
	const candidates = new Set(passwordCandidates(password))

	try {
		candidates.add(saslPrepPassword(password))
	} catch {
		// Prohibited characters: only the forms already listed can match.
	}

	for (const candidate of candidates) {
		const bits = document.authenticatePassword(candidate)

		if (bits !== 0) return { password: candidate, bits, openPassword }
	}

	throw new PdfEngineRefusal("needsPassword", "the document did not unlock again")
}

export function editing(context: PdfEngineContext): Editing {
	const open = context.open()

	if (open.edit === null) throw new PdfEngineRefusal("badRequest", "the document is not open for editing")

	return { ...open, edit: open.edit }
}

// The command context over `document`: pages loaded once per command, dropped after it.
function commandContext(
	context: PdfEngineContext,
	document: Mupdf.PDFDocument,
	edit: PdfEditSession
): { readonly command: PdfCommandContext; readonly release: () => void } {
	const pages = new Map<number, Mupdf.PDFPage>()

	return {
		command: {
			mupdf: context.mupdf,
			document,
			signatures: edit.signatures,
			page: index => {
				let page = pages.get(index)

				if (page === undefined) {
					page = document.loadPage(index)
					pages.set(index, page)
				}

				return page
			},
			pageOf: pageObject => edit.pageOf(document, pageObject),
			now: () => new Date()
		},
		release: () => {
			for (const page of pages.values()) page.destroy()

			pages.clear()
		}
	}
}

// The page and object number of the annotation a command's arguments name (PdfCommand.target), or null.
function targetOf(
	command: PdfCommand<unknown>,
	args: unknown
): {
	readonly page: number
	readonly id: number
	readonly field: "id" | "widget"
	readonly args: Readonly<Record<string, unknown>>
} | null {
	if (command.target === undefined || !isRecord(args)) return null

	const page = args["page"]
	const id = args[command.target]

	return isIndex(page) && isIndex(id) ? { page, id, field: command.target, args } : null
}

// One dispatch of a logged step run again: its target found by name (and named as the first run did), the annotation
// it makes named as then.
function runAgain(command: PdfCommand<unknown>, context: PdfCommandContext, args: unknown, key: PdfStepKey | undefined): void {
	const target = targetOf(command, args)
	let run = args

	if (target !== null && key !== undefined && (key.target !== null || key.at !== null)) {
		const id = resolveTarget(context.document, target.page, key)

		if (id === null) throw new PdfEngineRefusal("failed", "the annotation a step changed is gone")

		run = { ...target.args, [target.field]: id }
	}

	const outcome = command.run(context, run)
	const created = key === undefined ? null : key.created

	if (created !== null && "created" in outcome) nameCreated(context.document, outcome.created, created)
}

// Runs a logged step again (a redo the journal cannot make, a rebuild), as one journal operation.
function runStep(context: PdfEngineContext, edit: PdfEditSession, document: Mupdf.PDFDocument, step: LoggedStep): void {
	const command = pdfCommand(step.label)

	if (command === undefined) throw new PdfEngineRefusal("failed", `unknown command ${step.label}`)

	const { command: commandContextValue, release } = commandContext(context, document, edit)

	document.beginOperation(step.label)

	try {
		step.args.forEach((args, index) => {
			runAgain(command, commandContextValue, args, step.keys[index])
		})
	} catch (error) {
		document.abandonOperation()

		throw error
	} finally {
		release()
	}

	document.endOperation()

	if (step.tool === "pages") edit.pagesChanged()
}

// Unlocks a document opened again with the session's password, with the rights that password grants (an owner
// password unlocks owner rights even where the file opens without a password). False when it stays locked.
function unlock(document: Mupdf.PDFDocument, password: string | undefined): boolean {
	const locked = document.needsPassword()

	if (password === undefined || document.getTrailer().get("Encrypt").isNull()) return !locked
	if (document.authenticatePassword(password) !== 0) return true

	// The failed attempt dropped all access: a file that needs no password gets it back with the empty one.
	return !locked && document.authenticatePassword("") !== 0
}

// A written file held in the heap opened as a document in place (it keeps the buffer alive), unlocked with the
// document's password, scripts off and its journal on.
function openInPlace(context: PdfEngineContext, buffer: Mupdf.Buffer, password: string | undefined): Mupdf.PDFDocument {
	const opened = context.mupdf.Document.openDocument(buffer, "application/pdf").asPDF()

	// An encrypted file keeps its passwords: the one the document was opened with unlocks the written file.
	if (opened === null || !unlock(opened, password)) {
		opened?.destroy()

		throw new PdfEngineRefusal("failed", "the written file did not open")
	}

	if (opened.isJSSupported()) opened.disableJS()

	opened.enableJournal()

	return opened
}

// The file the history starts at (as the session opened it, or a written file it restarted on), opened again and
// unlocked.
function openBase(context: PdfEngineContext, open: Editing): Mupdf.PDFDocument {
	const { mupdf } = context
	let base: Mupdf.PDFDocument | null

	if (open.base !== null) base = mupdf.Document.openDocument(open.base, "application/pdf").asPDF()
	else {
		const stream = new mupdf.Stream(syncRangeStreamHandle(open.reader))

		try {
			base = mupdf.Document.openDocument(stream, "application/pdf").asPDF()
		} catch (error) {
			if (open.reader.failure !== null) throw new PdfEngineRefusal("readFailed", open.reader.failure)

			throw error
		} finally {
			stream.destroy()
		}
	}

	if (base === null) throw new PdfEngineRefusal("failed", "the document did not open again")

	const password = open.edit.password

	if (!unlock(base, password)) {
		base.destroy()

		throw new PdfEngineRefusal("needsPassword", "the document did not unlock again")
	}

	if (base.isJSSupported()) base.disableJS()

	base.setPageTreeCache(false)
	base.enableJournal()

	return base
}

// Replaces the document with the opened file and the first `count` logged steps run again.
export function rebuild(context: PdfEngineContext, open: Editing, count: number): void {
	const base = openBase(context, open)

	try {
		for (const step of open.edit.log.slice(0, count)) runStep(context, open.edit, base, step)
	} catch (error) {
		base.destroy()

		throw error
	}

	open.renderer.destroy()
	open.document.destroy()
	open.edit.pagesChanged()
	context.setCurrent({
		...open,
		document: base,
		renderer: new TileRenderer(context.mupdf, base, context.host.maxDisplayLists),
		source: open.base
	})
	context.mupdf.shrinkStore(50)
}

function widgetsOf(open: Editing, pages: readonly number[]): PdfPageWidgets[] {
	const count = open.document.countPages()

	return pages
		.filter(page => Number.isInteger(page) && page >= 0 && page < count)
		.map(page => {
			const loaded = open.document.loadPage(page)
			const widgets = pageWidgets(open.document, loaded, page, open.edit.signatures)

			loaded.destroy()

			return { page, widgets }
		})
}

// After a change: the touched pages render anew, and the answer carries their widgets.
export function changed(open: Editing, pages: readonly number[]): PdfCommandResult {
	open.renderer.evict(pages)

	return { pages, state: open.edit.snapshot(open.document), widgets: widgetsOf(open, pages) }
}

// Undo and redo change whatever the step changed: every page's rendering is dropped (pages with no cached list cost
// nothing), and the page asks again for the widgets it shows.
export function allPages(document: Mupdf.PDFDocument): number[] {
	return Array.from({ length: document.countPages() }, (_, index) => index)
}

// The protection a written file has, as the page and the verifying engine check it.
function saveProtection(security: PendingSecurity | null): PdfSaveProtection {
	if (security === null) return { kind: "keep" }

	const { options } = security

	return options.encrypt === "none"
		? { kind: "none" }
		: {
				kind: "new",
				userPassword: options["user-password"],
				ownerPassword: options["owner-password"],
				permissions: options.permissions
			}
}

// The written file's protection as planned: its /P, the owner password granting owner rights, the password to open
// granting user rights, and nothing else opening a file that needs a password. Run last: a failed attempt drops
// the document's access.
function checkProtection(document: Mupdf.PDFDocument, protection: PdfSaveProtection): string | null {
	const encrypt = document.getTrailer().get("Encrypt")

	if (protection.kind === "keep") return null
	if (protection.kind === "none") return encrypt.isNull() ? null : "the file is still encrypted"
	if (!encrypt.isDictionary()) return "the file is not encrypted"

	const permissions = encrypt.get("P")

	if (!permissions.isNumber() || (permissions.asNumber() | 0) !== (protection.permissions | 0)) return "its permissions differ"
	if ((document.authenticatePassword(protection.ownerPassword) & PDF_AUTH_OWNER) === 0) return "the owner password does not unlock it"
	if ((document.authenticatePassword(protection.userPassword) & (PDF_AUTH_USER | PDF_AUTH_OWNER)) === 0)
		return "the password to open does not open it"
	if (protection.userPassword !== "" && document.authenticatePassword("") !== 0) return "it opens without a password"

	return null
}

// Before a save writes: every page's display list goes and the resource store is emptied, so the write runs in memory
// the heap already has (core/pdfedit/budget.ts) rather than growing it past what it holds for the view.
export function freeForSave(context: PdfEngineContext): void {
	context.open().renderer.destroy()
	context.mupdf.emptyStore()
}

export function idle(edit: PdfEditSession): void {
	if (edit.output !== null) throw new PdfEngineRefusal("badRequest", "a save is under way")
}

export const EDIT_REQUESTS: Handlers = {
	state: context => {
		const { document, edit } = editing(context)

		return { value: edit.snapshot(document) }
	},
	widgets: (context, { pages }) => ({ value: widgetsOf(editing(context), pages) }),
	dispatch: (context, { command: name, args, op }) => {
		const open = editing(context)
		const { document, edit } = open
		const command = pdfCommand(name)

		if (command === undefined) throw new PdfEngineRefusal("badRequest", `unknown command ${name}`)

		idle(edit)

		const parsed = command.parse(args)

		if (parsed === null) throw new PdfEngineRefusal("badRequest", `malformed arguments for ${name}`)
		if (edit.snapshot(document).tools[command.tool] !== null)
			throw new PdfEngineRefusal("notAllowed", `${command.tool} is not allowed on this document`)

		// What it adds (a picture, another file's pages) must leave a document the editor can still save.
		const bytes = command.bytes?.(parsed, context.mupdf) ?? 0

		if (bytes > 0 && !fitsEdit(edit.fileBytes + edit.addedBytes() + bytes, edit.memory))
			throw new PdfEngineRefusal("overBudget", `${name} would grow the document past what this browser edits`)

		// The annotation it works on, as the history logs it (by name; named inside the step when it has none).
		const target = targetOf(command, parsed)
		const located = target === null ? null : targetKey(document, target.page, target.id, target.field === "widget")
		const key: PdfStepKey = located?.key ?? { target: null, at: null, created: null }

		edit.begin(document, { tool: command.saves ?? command.tool, label: name, args: parsed, key, bytes }, op?.id ?? null)

		const { command: commandContextValue, release } = commandContext(context, document, edit)
		let outcome: readonly number[] | PdfCommandOutcome

		try {
			located?.name()
			outcome = command.run(commandContextValue, parsed)

			// What it made is named in the step, so later steps find it by that name when they run again.
			if ("created" in outcome) key.created = nameCreated(document, outcome.created, null)
		} catch (error) {
			release()
			edit.fail(document)

			throw error
		}

		release()
		edit.finish(document, op === undefined || op.final)

		if (command.tool === "pages") edit.pagesChanged()

		const result = changed(open, outcomePages(outcome))

		return { value: "created" in outcome ? { ...result, created: outcome.created } : result }
	},
	undo: (context, { steps }) => {
		const open = editing(context)

		if (steps !== undefined && !(Number.isInteger(steps) && steps >= 1)) throw new PdfEngineRefusal("badRequest", "steps")

		idle(open.edit)
		open.edit.endOpen(open.document)
		open.edit.undo(
			open.document,
			count => {
				rebuild(context, open, count)
			},
			steps
		)
		open.edit.pagesChanged()

		return { value: changed(editing(context), allPages(context.open().document)) }
	},
	redo: context => {
		const open = editing(context)

		idle(open.edit)
		open.edit.endOpen(open.document)
		open.edit.redo(open.document, (document, step) => {
			runStep(context, open.edit, document, step)
		})
		open.edit.pagesChanged()

		return { value: changed(open, allPages(open.document)) }
	},
	saveBegin: (context, { inputBytes, memory, invalidateConfirmed }) => {
		const { document, edit } = editing(context)

		idle(edit)
		edit.endOpen(document)

		// A placed certificate signature is written only by its signing save (signBegin), never as a placeholder.
		if (pendingSignature(document) !== null) throw new PdfEngineRefusal("badRequest", "a signature placeholder is pending")

		const plan = planSave({
			inputBytes,
			signatures: edit.signatures,
			changes: edit.changes(),
			invalidateConfirmed,
			poisoned: false,
			memory,
			heap: { heapBytes: context.heapBytes(), addedBytes: edit.addedBytes() }
		})

		if (plan.refuse !== null) return { value: { status: "refused", plan, reason: plan.refuse } }

		freeForSave(context)

		// What the steps redacted (the verifier's manifest), and the protection the save writes.
		const steps = edit.appliedSteps()
		const redaction = redactionManifest(document, steps, pageObject => edit.pageOf(document, pageObject))
		const security = edit.security

		// Both remove or replace what the earlier revision holds: never appended to it.
		if ((redaction !== null || security !== null) && plan.mode !== "full")
			throw new PdfEngineRefusal("failed", "a redaction or a new protection needs a full rewrite")

		// A rewrite is one revision; an incremental save adds one to the file's own, when something changed.
		const versions = plan.mode === "full" ? 1 : document.countVersions() + (document.hasUnsavedChanges() ? 1 : 0)
		const options = composeWriteOptions(
			redaction === null ? plan.options : REDACTION_SAVE_OPTIONS,
			security?.options ?? { encrypt: "keep" }
		)
		const buffer = document.saveToBuffer(options)
		const encryption = security === null ? edit.encryption : security.options.encrypt === "none" ? "None" : PDF_AES256_METHOD
		// Content removed since the last save stays in the file's earlier versions when this one is saved in place.
		const removesContent = steps.slice(Math.max(edit.savedApplied, 0)).some(step => pdfCommand(step.label)?.removesContent === true)

		edit.output = {
			buffer,
			plan,
			serving: [],
			previousSaved: edit.savedApplied,
			security,
			encryption,
			// Signatures it invalidated: what the engine checks from now on is the written file, never the signed one.
			resets: redaction !== null || security !== null || plan.invalidates.length > 0
		}
		edit.savedApplied = edit.applied
		edit.written()
		// The write decoded what it copied: it goes again.
		context.mupdf.emptyStore()

		return {
			value: {
				status: "written",
				plan,
				size: buffer.getLength(),
				versions,
				encryption,
				redaction,
				removesContent,
				protection: saveProtection(security)
			}
		}
	},
	serveOutput: (context, { buffer, port }) => {
		const { edit } = editing(context)
		const output = edit.output

		if (output === null) throw new PdfEngineRefusal("badRequest", "no save is held")

		const lifetime = new EngineLifetime()

		output.serving.push(lifetime)
		serveSyncRange(
			buffer,
			port,
			{
				length: output.buffer.getLength(),
				// A copy of the range: a view of the heap is never handed out (a later allocation could detach it).
				read: (start, end) =>
					lifetime.aborted || edit.output !== output
						? Promise.reject(new Error("the save ended"))
						: Promise.resolve(output.buffer.asUint8Array().slice(start, end))
			},
			{ lifetime, readAhead: 0, onReaderClose: () => lifetime.abort() }
		)

		return { value: null }
	},
	writeOutput: async (context, { port }) => {
		const { edit } = editing(context)
		const output = edit.output

		if (output === null) throw new PdfEngineRefusal("badRequest", "no save is held")

		const writer = savePortWriter(port as SavePortEnd)
		const length = output.buffer.getLength()

		// Requests run one at a time: until the upload settles or either end aborts, nothing else runs here (a page that
		// gives up on the upload aborts its end of the port).
		writer.announce()

		try {
			for (let at = 0; at < length; at += OUTPUT_SLICE) {
				if (edit.output !== output) throw new Error("the save ended")

				// A view of the heap, taken now (nothing runs in MuPDF meanwhile); the writer copies it into its own chunks.
				await writer.write(output.buffer.asUint8Array().subarray(at, Math.min(length, at + OUTPUT_SLICE)))
			}

			await writer.close()
			writer.commit()
		} catch {
			writer.abort("failed")

			return { value: { uploaded: false } }
		}

		return { value: { uploaded: await writer.uploaded } }
	},
	saveEnd: (context, { outcome, next }) => {
		const open = editing(context)
		const { edit } = open
		const output = edit.output

		if (output === null) throw new PdfEngineRefusal("badRequest", "no save is held")

		for (const lifetime of output.serving) lifetime.abort()

		// Written elsewhere (a copy) or not at all: the file is as it was, and so is what is unsaved in it.
		if (outcome !== "saved") edit.savedApplied = output.previousSaved
		else edit.fileBytes = output.buffer.getLength()

		// A redaction, new protection or invalidated signatures that became the file always start again on it: the
		// document in memory still holds what was redacted (in its history), the old protection, or reads as the signed
		// file it was opened from.
		const restart = next === "adopt" || output.resets

		// A rewrite leaves the document as it was (the next save writes it whole again). After an incremental save MuPDF
		// takes the output as the document's file, so the next revision must be appended to it: the document is opened on
		// it, in place. The history goes on unless asked to start again; a step back past the save rebuilds from the file
		// the history starts at (the base).
		if (outcome !== "saved" || (!restart && output.plan.mode === "full")) {
			// Kept: the drive now holds the rewrite, not the file the document reads.
			if (outcome === "saved") edit.fileBehind = true

			edit.close()

			return { value: { state: edit.snapshot(open.document), heapBytes: context.heapBytes(), history: "kept" } }
		}

		edit.output = null
		edit.fileBehind = false
		edit.ownFile = true

		// The written file opens with its new passwords.
		if (output.security !== null) edit.protectedAs(output.security.options, output.encryption)

		const adopted = openInPlace(context, output.buffer, edit.password)

		open.renderer.destroy()
		open.document.destroy()

		// The previous in-place file goes unless the history still starts at it.
		if (open.heap !== null && open.heap !== open.base) open.heap.destroy()

		if (restart) {
			if (open.base !== null) open.base.destroy()

			open.reader.close()
			edit.reset(adopted, fileRevisions(context.mupdf, output.buffer, edit.password))
		}

		context.setCurrent({
			...open,
			document: adopted,
			renderer: new TileRenderer(context.mupdf, adopted, context.host.maxDisplayLists),
			heap: output.buffer,
			base: restart ? output.buffer : open.base,
			source: output.buffer
		})
		context.mupdf.emptyStore()

		return { value: { state: edit.snapshot(adopted), heapBytes: context.heapBytes(), history: restart ? "reset" : "kept" } }
	},
	text: (context, { page }) => {
		const { document } = context.open()

		if (!Number.isInteger(page) || page < 0 || page >= document.countPages()) throw new PdfEngineRefusal("badRequest")

		const loaded = document.loadPage(page)
		const bounds = new Map<number, Mupdf.Rect>([[page, loaded.getBounds()]])
		const boundsOf = (index: number): Mupdf.Rect | null => {
			if (!Number.isInteger(index) || index < 0 || index >= document.countPages()) return null

			let rect = bounds.get(index)

			if (rect === undefined) {
				const target = document.loadPage(index)

				rect = target.getBounds()
				target.destroy()
				bounds.set(index, rect)
			}

			return rect
		}

		try {
			return { value: { lines: pageTextLines(loaded), links: pageTextLinks(document, loaded, boundsOf) } }
		} finally {
			loaded.destroy()
		}
	},
	destination: (context, args) => {
		const { document } = context.open()
		const count = document.countPages()
		let page: number | null = null
		let point: { readonly x: number; readonly y: number; readonly type: string } | null = null

		if ("name" in args) {
			try {
				const resolved = document.resolveLinkDestination(`#nameddest=${encodeURIComponent(args.name)}`)

				page = resolved.page
				point = resolved
			} catch {
				return { value: null }
			}
		} else {
			for (let index = 0; index < count && page === null; index++) {
				const object = document.findPage(index)

				if (object.isIndirect() && object.asIndirect() === args.pageObject) page = index
			}
		}

		if (page === null || !Number.isInteger(page) || page < 0 || page >= count) return { value: null }

		const loaded = document.loadPage(page)
		const bounds = loaded.getBounds()

		loaded.destroy()

		return { value: point === null ? { page, left: null, top: null } : { page, ...pointOf(point, bounds) } }
	},
	checkSaved: (context, expected) => {
		const { document, role } = context.open()

		if (role !== "verify") throw new PdfEngineRefusal("badRequest", "only a verifying engine checks a written file")

		const encryption = document.getMetaData("encryption") ?? "None"

		if (encryption !== expected.encryption)
			return { value: { ok: false, reason: `encryption ${encryption}, expected ${expected.encryption}` } }

		const versions = document.countVersions()

		if (versions !== expected.versions)
			return { value: { ok: false, reason: `${String(versions)} revisions, expected ${String(expected.versions)}` } }

		const pages = document.countPages()

		if (pages !== expected.pageCount)
			return { value: { ok: false, reason: `${String(pages)} pages, expected ${String(expected.pageCount)}` } }

		// Every page loads and runs (its content and annotations parse) without drawing anything.
		for (let index = 0; index < pages; index++) {
			const page = document.loadPage(index)
			const list = page.toDisplayList(true)

			list.destroy()
			page.destroy()
		}

		const protection = expected.protection === undefined ? null : checkProtection(document, expected.protection)

		if (protection !== null) return { value: { ok: false, reason: protection } }

		return { value: { ok: true } }
	}
}
