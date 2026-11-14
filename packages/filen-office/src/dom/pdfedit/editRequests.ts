import type * as Mupdf from "mupdf"
import { savePortWriter, type SavePortEnd } from "@filen/shared/savePort"
import { planSave } from "../../core/pdfedit/savePlan"
import type { PdfCommandResult, PdfPageWidgets } from "../../core/pdfedit/state"
import { pdfCommand } from "./commands/index"
import type { PdfCommandContext } from "./commands/types"
import { PdfEngineRefusal, type OpenDocument, type PdfEngineContext } from "./context"
import { EngineLifetime, PdfEditSession, restrictionsOf, type LoggedStep } from "./editSession"
import { pageWidgets } from "./formState"
import type { PdfOpenResult } from "./protocol"
import type { PdfRequestHandler } from "./requests"
import { TileRenderer } from "./render"
import { syncRangeStreamHandle } from "./stream"
import { serveSyncRange } from "./syncRange"
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

type Editing = OpenDocument & { readonly edit: PdfEditSession }

// Starts the editor's bookkeeping on an unlocked document: the journal from here on.
export function startEdit(
	document: Mupdf.PDFDocument,
	opened: Extract<PdfOpenResult, { status: "open" }>,
	password: string | undefined
): PdfEditSession {
	document.enableJournal()

	const { encryption, permissions } = opened.document

	return new PdfEditSession(document, {
		access: opened.access,
		encryption,
		restrictions: restrictionsOf(permissions, opened.access, encryption),
		...(password === undefined ? {} : { password })
	})
}

function editing(context: PdfEngineContext): Editing {
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

// Runs a logged step again (a redo the journal cannot make, a rebuild), as one journal operation.
function runStep(context: PdfEngineContext, edit: PdfEditSession, document: Mupdf.PDFDocument, step: LoggedStep): void {
	const command = pdfCommand(step.label)

	if (command === undefined) throw new PdfEngineRefusal("failed", `unknown command ${step.label}`)

	const { command: commandContextValue, release } = commandContext(context, document, edit)

	document.beginOperation(step.label)

	try {
		for (const args of step.args) command.run(commandContextValue, args)
	} catch (error) {
		document.abandonOperation()

		throw error
	} finally {
		release()
	}

	document.endOperation()

	if (step.tool === "pages") edit.pagesChanged()
}

// A written file held in the heap opened as a document in place (it keeps the buffer alive), unlocked with the
// document's password, scripts off and its journal on.
function openInPlace(context: PdfEngineContext, buffer: Mupdf.Buffer, password: string | undefined): Mupdf.PDFDocument {
	const opened = context.mupdf.Document.openDocument(buffer, "application/pdf").asPDF()

	// An encrypted file keeps its passwords: the one the document was opened with unlocks the written file.
	if (opened === null || (opened.needsPassword() && (password === undefined || opened.authenticatePassword(password) === 0))) {
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

	if (base.needsPassword() && (password === undefined || base.authenticatePassword(password) === 0)) {
		base.destroy()

		throw new PdfEngineRefusal("needsPassword", "the document did not unlock again")
	}

	if (base.isJSSupported()) base.disableJS()

	base.setPageTreeCache(false)
	base.enableJournal()

	return base
}

// Replaces the document with the opened file and the first `count` logged steps run again.
function rebuild(context: PdfEngineContext, open: Editing, count: number): void {
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
	context.setCurrent({ ...open, document: base, renderer: new TileRenderer(context.mupdf, base, context.host.maxDisplayLists) })
	context.mupdf.shrinkStore(50)
}

function widgetsOf(open: Editing, pages: readonly number[]): PdfPageWidgets[] {
	const count = open.document.countPages()

	return pages
		.filter(page => Number.isInteger(page) && page >= 0 && page < count)
		.map(page => {
			const loaded = open.document.loadPage(page)
			const widgets = pageWidgets(loaded, page, open.edit.signatures)

			loaded.destroy()

			return { page, widgets }
		})
}

// After a change: the touched pages render anew, and the answer carries their widgets.
function changed(open: Editing, pages: readonly number[]): PdfCommandResult {
	open.renderer.evict(pages)

	return { pages, state: open.edit.snapshot(open.document), widgets: widgetsOf(open, pages) }
}

// Undo and redo change whatever the step changed: every page's rendering is dropped (pages with no cached list cost
// nothing), and the page asks again for the widgets it shows.
function allPages(document: Mupdf.PDFDocument): number[] {
	return Array.from({ length: document.countPages() }, (_, index) => index)
}

function idle(edit: PdfEditSession): void {
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

		edit.begin(document, name, command.tool, parsed, op?.id ?? null)

		const { command: commandContextValue, release } = commandContext(context, document, edit)
		let pages: readonly number[]

		try {
			pages = command.run(commandContextValue, parsed)
		} catch (error) {
			release()
			edit.fail(document)

			throw error
		}

		release()
		edit.finish(document, op === undefined || op.final)

		if (command.tool === "pages") edit.pagesChanged()

		return { value: changed(open, pages) }
	},
	undo: context => {
		const open = editing(context)

		idle(open.edit)
		open.edit.endOpen(open.document)
		open.edit.undo(open.document, count => {
			rebuild(context, open, count)
		})
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

		const plan = planSave({
			inputBytes,
			signatures: edit.signatures,
			changes: edit.changes(),
			invalidateConfirmed,
			poisoned: false,
			memory
		})

		if (plan.refuse !== null) return { value: { status: "refused", plan, reason: plan.refuse } }

		// A rewrite is one revision; an incremental save adds one to the file's own, when something changed.
		const versions = plan.mode === "full" ? 1 : document.countVersions() + (document.hasUnsavedChanges() ? 1 : 0)
		const buffer = document.saveToBuffer(plan.options)

		edit.output = { buffer, plan, serving: [], previousSaved: edit.savedApplied }
		edit.savedApplied = edit.applied
		edit.written()
		// The write decoded what it copied: half of the resource store goes again.
		context.mupdf.shrinkStore(50)

		return { value: { status: "written", plan, size: buffer.getLength(), versions } }
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

		// A rewrite leaves the document as it was (the next save writes it whole again). After an incremental save MuPDF
		// takes the output as the document's file, so the next revision must be appended to it: the document is opened on
		// it, in place. The history goes on unless asked to start again; a step back past the save rebuilds from the file
		// the history starts at (the base).
		if (outcome !== "saved" || (next === "continue" && output.plan.mode === "full")) {
			edit.close()

			return { value: { state: edit.snapshot(open.document), heapBytes: context.heapBytes(), history: "kept" } }
		}

		edit.output = null

		const adopted = openInPlace(context, output.buffer, edit.password)
		const restart = next === "adopt"

		open.renderer.destroy()
		open.document.destroy()

		// The previous in-place file goes unless the history still starts at it.
		if (open.heap !== null && open.heap !== open.base) open.heap.destroy()

		if (restart) {
			if (open.base !== null) open.base.destroy()

			open.reader.close()
			edit.reset(adopted)
		}

		context.setCurrent({
			...open,
			document: adopted,
			renderer: new TileRenderer(context.mupdf, adopted, context.host.maxDisplayLists),
			heap: output.buffer,
			base: restart ? output.buffer : open.base
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

		return { value: { ok: true } }
	}
}
