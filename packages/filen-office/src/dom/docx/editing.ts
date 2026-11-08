import type { Node } from "prosemirror-model"
import { RevisionView } from "../../core/docx/index"
import {
	DocxEditorSession,
	openDocxEditContext,
	prepareStoryReviewIndex,
	proveBlocksSteps,
	type BlockProof,
	type DocxEditContext,
	type DocxEditorOptions,
	type DocxMediaInfo,
	type LockReason,
	authorInitials
} from "../../core/docx/edit/index"
import type { DocumentLayout } from "../../core/docx/layout/document"
import { DocumentEdits, PagedEditor, type PagedEditorOptions } from "../../core/docx/paged/index"
import { mediaInUse, releaseUnusedMedia, settleMedia } from "../../core/docx/objects/edit"
import { compositionMarked, flushComposition } from "../../core/docx/review/track"
import type { DocxPrepareOptions, DocxPreparedSave, DocxSaveInput, DocxSaveTimings } from "../../core/docx/write/save"
import type { Slicing } from "../../core/slicing"
import type { DocxAbortSignal } from "./protection"
import { HitTester } from "../../core/text/index"
import type { XmlDocument } from "../../core/xml/index"
import { DocxEngine, type DocxEngineOpen, type DocxEngineServices } from "./engine"
import type { DocxHost } from "./host"
import type { DocxPdfLive } from "./pdfSnapshot"
import type { DocxOpenOptions } from "./protocol"
import { isSealedOfficeFile } from "../../core/encryption/index"
import { PackageSealError, packageSealer, type PackageSealer } from "../encryption/seal"
import { importOfficeKey, type AbortSignalLike, type OfficeKeyTransfer } from "../encryption/webCrypto"
import { DocxClosedError, inThreadDocxZipper, type DocxSaveNotice, type DocxZipper, type DocxZipperFactory } from "./save"

// A password-protected document's saves: sealed with the key the document's holder handed over
// (DocxUnlockedDocument.take), on this thread, in the editor's own chain (a viewer never loads seal code).
export type DocxSealer = PackageSealer
export { PackageSealError as DocxSealError, isSealedOfficeFile }

// Where an editor's key comes from: a taken document's key() (protection.ts), asked at the first seal.
export interface DocxKeySource {
	key(options?: { readonly signal?: AbortSignalLike }): Promise<OfficeKeyTransfer>
}

// The sealer for DocxEditingOptions.encryption. Its first seal asks `source` for the key (a Standard source's
// upgrade spin runs then, where the document is held, while editing goes on) and registers it here; a save waits
// for it, so nothing is handed out unsealed. release() drops the key on this thread (the editor closed).
export function docxSealer(source: DocxKeySource): { readonly sealer: DocxSealer; release(): void } {
	let released = false
	let held: Promise<{ readonly sealer: PackageSealer; release(): void }> | undefined

	const sealerOf = (signal: AbortSignalLike | undefined): Promise<{ readonly sealer: PackageSealer; release(): void }> => {
		held ??= source.key(signal === undefined ? {} : { signal }).then(
			key => {
				const imported = packageSealer(importOfficeKey(key))

				// Released while the key was on its way: it goes at once.
				if (released) imported.release()

				return imported
			},
			(error: unknown) => {
				// Asked again by the next seal.
				held = undefined

				throw error
			}
		)

		return held
	}

	return {
		sealer: {
			get released() {
				return released
			},
			async seal(zip, options = {}) {
				if (released) throw new PackageSealError("released", "The package's key was released")

				let imported: { readonly sealer: PackageSealer }

				try {
					imported = await sealerOf(options.signal)
				} catch (error) {
					if (released) throw new PackageSealError("released", "The package's key was released")
					if (options.signal?.aborted === true) throw new PackageSealError("aborted", "The seal was aborted")

					throw new PackageSealError("check", error instanceof Error ? error.message : String(error))
				}

				if (released) throw new PackageSealError("released", "The package's key was released")

				return imported.sealer.seal(zip, options)
			}
		},
		release() {
			if (released) return

			released = true
			void held?.then(
				imported => imported.release(),
				() => undefined
			)
		}
	}
}

// Editing runs on the thread that shows the pages (web main thread, mobile WebView), with the model, the
// layout and the editing session in one realm: no model copy, no mirroring protocol, one code path for
// both platforms. The engine still sends pages as events (the same renderer draws them); edits lay out
// again in the keystroke's task as far as the pages in view, the rest in slices.

export interface DocxEditingHost {
	// Opens the document (pass to DocxDocumentStore as its source's host); one document per editing host.
	readonly host: DocxHost
	// The paged editor once the document is open for editing; rejects when it could not be.
	readonly editor: Promise<PagedEditor>
	// What saveDocx / planDocxSave write (every story's session) once the editor is open, else undefined.
	saveInput(): DocxSaveInput | undefined
	// Writes the document as `sessions` hold it (default every story's session; stand-ins from withReverted to
	// write some blocks as last saved): the lossless writer and the part half of gate 2 in slices on this
	// thread, then the zip and its half of gate 2 in the zipper (DocxEditingOptions.writer). The editor must
	// not change the documents meanwhile (they are read once, as the save starts). Rejects with a
	// DocxSaveError when the writer refuses, with a DocxClosedError when the document closed first. An encrypted
	// document's file is then sealed and checked (DocxEditingOptions.encryption); a failure there rejects with a
	// DocxSealError, nothing handed out. `signal`: a write nothing stores (Download as) may be given up: it ends at
	// its next slice or stage and rejects with an AbortError, nothing handed out.
	save(sessions?: readonly DocxEditorSession[], options?: { readonly signal?: DocxAbortSignal }): Promise<DocxWritten>
	// The writer and the part half of gate 2 alone, in slices (nothing zipped or stored): whether, and what,
	// a save of `sessions` would write.
	prepare(sessions?: readonly DocxEditorSession[]): Promise<DocxPreparedSave>
	// Body blocks the proof locked as the document opened (0 before then, or without a proof).
	proofLocked(): number
	// The document author name for comments and tracked changes (the app asked the user; never filled in for
	// them); undefined clears it. Holds for the document from now on, also before it opened.
	setAuthor(name: string | undefined): void
	// Shows tracked changes another way (DocxOpenOptions.view), laid out again in place: no reopen. False
	// before the editor opened or when the document already shows that view.
	setView(view: "final" | "markup" | "original"): boolean
	// Registers bytes a command will use (a picture to insert): their handle, or undefined when over the size
	// limit or before the editor opened. Kept through saves until an image.insert names it, or releaseMedia.
	addMedia(chunks: Uint8Array | readonly Uint8Array[], info?: DocxMediaInfo): number | undefined
	// Gives up a handle addMedia gave that no command will use (the user cancelled, say): its bytes go now.
	releaseMedia(handle: number): void
	// The document with its unsaved edits in the Final view, for PDF export (pdfSnapshot.ts): the pages as laid
	// out when they show that view, else laid out again apart. Undefined before it opened or once closed.
	pdfSource(signal?: { readonly aborted: boolean }): Promise<DocxPdfLive | undefined>
}

export interface DocxWritten {
	// The file to store: for an encrypted document the sealed compound file, never the package itself.
	readonly bytes: Uint8Array
	// Sealed with the document's password (DocxEditingOptions.encryption).
	readonly encrypted: boolean
	readonly changedParts: readonly string[]
	// sealMs: sealing and its check, for an encrypted document.
	readonly timings: DocxSaveTimings & { readonly sealMs?: number }
	// What the save wrote otherwise than the edit has it (DocxZipped.notices), for the user to be told.
	readonly notices?: readonly DocxSaveNotice[]
}

export interface DocxEditingOptions {
	readonly session?: Omit<DocxEditorOptions, "story">
	// The document author name (see DocxEditingHost.setAuthor) and the clock dates written into the file read.
	readonly author?: string
	readonly clock?: () => number
	readonly paged?: PagedEditorOptions
	// Gate 1 for the document, made from its editing context (writerProof, injected: the writer is not part
	// of this entry). The body is proved in slices before the editor opens; other stories when entered.
	readonly proof?: (context: DocxEditContext) => BlockProof | DocxLaterProof
	// The writer for save() and prepare() (prepareDocxSave, injected like the proof), and where saves zip the
	// file (default: on this thread; web passes a worker's, docxZipWorker). Without it the host cannot save.
	readonly writer?: DocxEditingWriter
	// The document's password to modify was given (edit/protection.ts gateLifted): its write protection does
	// not make it view-only for this session.
	readonly writeUnlocked?: boolean
	// The user stopped the document's protection (edit/protection.ts documentProtectionOf): none applies for
	// this session, and saves write it switched off.
	readonly protectionUnlocked?: boolean
	// The document was opened from a password-protected file (docxSealer): every save is sealed with its key
	// after the zip and its Gate 2, and checked, before the bytes are handed out.
	readonly encryption?: DocxSealer
}

// A Gate 1 partly made elsewhere (an RTF document's writer proves in its worker): the body is checked with `first`
// while `later` comes, then locked with `extra` before `first`'s verdicts; other stories are proved with `full`.
// Editing starts after, so no edit precedes a lock.
export interface DocxLaterProof {
	readonly first: BlockProof
	readonly later: Promise<{ readonly extra: BlockProof; readonly full: BlockProof }>
}

export interface DocxEditingWriter {
	readonly prepare: (input: DocxSaveInput, options: DocxPrepareOptions) => Promise<DocxPreparedSave>
	readonly zipper?: DocxZipperFactory
}

// Why a write given up (its signal) ended.
function abortError(): Error {
	const error = new Error("The write was aborted")

	error.name = "AbortError"

	return error
}

function throwIfAborted(signal: DocxAbortSignal | undefined): void {
	if (signal?.aborted === true) throw abortError()
}

// `slicing` that ends the write at its next pause once `signal` aborts.
function abortableSlicing(slicing: Slicing, signal: DocxAbortSignal): Slicing {
	return {
		sliceMs: slicing.sliceMs,
		now: slicing.now,
		pause: async () => {
			await slicing.pause()
			throwIfAborted(signal)
		}
	}
}

// Top-level blocks proved per run, and the size (positions) a run stops before: each run is proved a block
// at a time (a long table a few rows at a time), then its failed blocks are locked.
const PROOF_CHUNK = 32
const PROOF_SIZE = 4096

// Gate 1 over the body's blocks in slices (no long task however long the document): each run of top-level
// blocks is proved in steps, then the next run starts after them however the locks resized them. The
// locks are not edits: the session is marked saved again. Returns the blocks locked.
async function proveInSlices(session: DocxEditorSession, proof: BlockProof, slicing: Slicing, closed: () => boolean): Promise<number> {
	let locked = 0
	let index = 0
	let from = 0
	let started = slicing.now()

	for (;;) {
		const doc = session.state.doc

		if (index >= doc.childCount || closed()) break

		let to = from
		let end = index

		while (end < doc.childCount && end - index < PROOF_CHUNK) {
			const size = doc.child(end).nodeSize

			if (end > index && to - from + size > PROOF_SIZE) break

			to += size
			end++
		}

		const failed = new Map<Node, LockReason>()
		const recording = recordingProof(proof, failed)
		let looks = 0
		// The clock is read every few steps (a step can be one table cell).
		const due = (): boolean => (++looks & 15) === 0 && slicing.now() - started >= slicing.sliceMs
		// Each run starts the walk at its own first block.
		const start = { index, pos: from }
		const steps = proveBlocksSteps(session.story, doc, recording, due, from, to, start)

		for (let step = steps.next(); step.done !== true; step = steps.next()) {
			await slicing.pause()
			started = slicing.now()

			if (closed()) return locked
		}

		if (slicing.now() - started >= slicing.sliceMs) {
			await slicing.pause()
			started = slicing.now()

			if (closed()) return locked
		}

		// The run's verdicts lock what failed (proved again should the document have changed meanwhile).
		locked +=
			session.state.doc === doc ? session.prove({ check: node => failed.get(node) }, from, to, start) : session.prove(proof, from, to)
		from = to + session.state.doc.content.size - doc.content.size
		index = end
	}

	if (locked > 0) session.markSaved()

	return locked
}

// `proof`, keeping what fails in `failed`.
function recordingProof(proof: BlockProof, failed: Map<Node, LockReason>): BlockProof {
	return {
		check(node, story) {
			const reason = proof.check(node, story)

			if (reason !== undefined) failed.set(node, reason)

			return reason
		},
		*steps(node, story, due) {
			const reason = proof.steps === undefined ? proof.check(node, story) : yield* proof.steps(node, story, due)

			if (reason !== undefined) failed.set(node, reason)

			return reason
		}
	}
}

// Gate 1's verdicts over the body in slices, nothing locked (a DocxLaterProof's `first`); undefined once closed.
async function verdictsInSlices(
	session: DocxEditorSession,
	proof: BlockProof,
	slicing: Slicing,
	closed: () => boolean
): Promise<Map<Node, LockReason> | undefined> {
	const failed = new Map<Node, LockReason>()
	let started = slicing.now()
	let looks = 0
	const due = (): boolean => (++looks & 15) === 0 && slicing.now() - started >= slicing.sliceMs
	const steps = proveBlocksSteps(session.story, session.state.doc, recordingProof(proof, failed), due)

	for (let step = steps.next(); step.done !== true; step = steps.next()) {
		await slicing.pause()

		if (closed()) return undefined

		started = slicing.now()
	}

	return failed
}

// Pages laid out before the editor's open takes the thread from the layout: the first screen paints first.
const FIRST_PAGES = 3

// The editor's open (the body's build, Gate 1, the review index) before the engine's layout beyond the first
// pages: each engine turn waits while the open holds. Both still run in slices, so no task is long.
class OpenPriority {
	private layout: DocumentLayout | undefined = undefined
	private released: Promise<void> | undefined = undefined
	private releaser: (() => void) | undefined = undefined

	hold(layout: DocumentLayout): void {
		this.layout = layout
		this.released ??= new Promise(resolve => {
			this.releaser = resolve
		})
	}

	release(): void {
		this.layout = undefined
		this.released = undefined
		this.releaser?.()
		this.releaser = undefined
	}

	engineYield(pause: () => Promise<void>): () => Promise<void> {
		return async () => {
			await pause()

			const layout = this.layout

			if (layout !== undefined && this.released !== undefined && (layout.final || layout.pages.length >= FIRST_PAGES))
				await this.released
		}
	}
}

// A styles or numbering part as opened, or undefined (missing or unreadable: the save writes a new one).
async function partXml(open: DocxEngineOpen, kind: string): Promise<XmlDocument | undefined> {
	const name = open.pkg.part(kind)

	if (name === undefined || !open.pkg.has(name)) return undefined

	try {
		return await open.pkg.xml(name)
	} catch {
		return undefined
	}
}

export function inThreadEditingHost(
	services: (options: DocxOpenOptions) => DocxEngineServices,
	editing: DocxEditingOptions = {}
): DocxEditingHost {
	let resolve: (editor: PagedEditor) => void = () => undefined
	let reject: (error: unknown) => void = () => undefined
	const editor = new Promise<PagedEditor>((done, fail) => {
		resolve = done
		reject = fail
	})
	let opened = false
	let saveInput: DocxSaveInput | undefined
	let proofLocked = 0
	let author = editing.author
	let current: PagedEditor | undefined
	// Set once the editor is open: how saves slice their work here, and the zipper.
	let writing: { readonly slicing: Slicing; readonly zipper: DocxZipper } | undefined
	// Overlay merges wait while a save reads the sessions (DocumentEdits.holdCompaction).
	let holdMerges: () => () => void = () => () => undefined
	// `checksums`: a trial (nothing zipped) skips the parts' CRCs.
	// What an IME composition typed is marked as tracked before anything is written (it would be written as
	// untracked text). A composition still going on is written marked as it stands, the session left as it is
	// (a transaction now would end the composition in the view); it is marked when the composition ends.
	const flushed = (): DocxSaveInput | undefined => {
		if (saveInput === undefined) return undefined

		if (current?.composition === undefined) {
			for (const session of saveInput.sessions) flushComposition(session)

			return saveInput
		}

		const docs = new Map<DocxEditorSession, Node>()

		for (const session of saveInput.sessions) {
			const doc = compositionMarked(session)

			if (doc !== undefined) docs.set(session, doc)
		}

		return docs.size === 0 ? saveInput : { ...saveInput, docs }
	}
	const held = async <T>(run: () => Promise<T>): Promise<T> => {
		const release = holdMerges()

		try {
			return await run()
		} finally {
			release()
		}
	}
	const prepare = (
		sessions: readonly DocxEditorSession[] | undefined,
		checksums: boolean,
		signal?: DocxAbortSignal
	): Promise<DocxPreparedSave> => {
		const input = flushed()

		if (editing.writer === undefined) return Promise.reject(new Error("This editing host has no writer"))
		if (input === undefined || writing === undefined) return Promise.reject(new DocxClosedError())

		return editing.writer.prepare(
			{
				pkg: input.pkg,
				context: input.context,
				sessions: sessions ?? input.sessions,
				...(input.docs === undefined ? {} : { docs: input.docs })
			},
			{ slicing: signal === undefined ? writing.slicing : abortableSlicing(writing.slicing, signal), checksums }
		)
	}
	const save = (sessions?: readonly DocxEditorSession[], options: { readonly signal?: DocxAbortSignal } = {}): Promise<DocxWritten> =>
		held(() => written(sessions, options.signal))
	const written = async (
		sessions: readonly DocxEditorSession[] | undefined,
		signal: DocxAbortSignal | undefined
	): Promise<DocxWritten> => {
		throwIfAborted(signal)

		// Handles added after this may be on their way into a command: the release below keeps them.
		const through = saveInput?.context.media.lastHandle ?? 0
		const prepared = await prepare(sessions, true, signal)

		if (writing === undefined) throw new DocxClosedError()

		throwIfAborted(signal)

		const slicing = signal === undefined ? writing.slicing : abortableSlicing(writing.slicing, signal)
		const zipped = await writing.zipper.zip(prepared)

		throwIfAborted(signal)

		const sealer = editing.encryption
		const sealing = slicing.now()
		const bytes = sealer === undefined ? zipped.bytes : await sealer.seal(zipped.bytes, { slicing })

		throwIfAborted(signal)
		const sealMs = slicing.now() - sealing

		// A zip must never leave an encrypted document's save.
		if (sealer !== undefined && !isSealedOfficeFile(bytes))
			throw new PackageSealError("check", "An encrypted document's save is not sealed")

		const live = saveInput

		// Pictures no story (nor its undo history) can bring back are dropped from memory.
		if (live !== undefined)
			releaseUnusedMedia(
				live.context,
				live.sessions.map(session => session.state),
				through
			)

		return {
			bytes,
			encrypted: sealer !== undefined,
			changedParts: zipped.changedParts,
			timings: {
				serializeMs: prepared.serializeMs,
				verifyPartsMs: prepared.verifyPartsMs,
				zipMs: zipped.zipMs,
				verifyZipMs: zipped.verifyZipMs,
				...(sealer === undefined ? {} : { sealMs })
			},
			...(zipped.notices === undefined || zipped.notices.length === 0 ? {} : { notices: zipped.notices })
		}
	}

	// The open document's engine (one per editing host).
	let liveEngine: DocxEngine | undefined

	const host: DocxHost = (source, listener, options = {}) => {
		if (opened) throw new Error("An editing host opens one document")

		opened = true

		let closed = false
		let paged: PagedEditor | undefined
		const view =
			options.view === "original" ? RevisionView.Original : options.view === "markup" ? RevisionView.Markup : RevisionView.Final
		let edits: DocumentEdits | undefined
		const engineServices = services(options)
		// While the body is built and proved, the engine's turns (its layout) wait once the first pages are laid
		// out: editing comes as soon as it would without layout beyond the pages in view.
		const priority = new OpenPriority()
		const engine: DocxEngine = new DocxEngine(
			source,
			{ ...engineServices, yield: priority.engineYield(engineServices.yield) },
			event => {
				if (closed) return

				listener(event)

				if (event.type === "error") reject(new Error(event.message))
			},
			options,
			{
				prepare(model) {
					edits = new DocumentEdits(model, view)

					return { model: edits.model, edits }
				},
				opened(open: DocxEngineOpen) {
					void start(open)
						.catch((error: unknown) => reject(error))
						.finally(() => priority.release())
				}
			}
		)
		const start = async (open: DocxEngineOpen): Promise<void> => {
			const context = await openDocxEditContext(open.pkg, open.model, {
				store: open.store,
				...(open.styles === undefined ? {} : { styles: open.styles }),
				...(open.numbering === undefined ? {} : { numbering: open.numbering }),
				resolver: open.resolver,
				...(editing.clock === undefined ? {} : { clock: editing.clock }),
				...(editing.writeUnlocked === true ? { writeUnlocked: true } : {}),
				...(editing.protectionUnlocked === true ? { protectionUnlocked: true } : {})
			})

			// The name as it is now (setAuthor may have changed it since the host was made).
			context.identity.author = author
			context.identity.initials = author === undefined ? undefined : authorInitials(author)

			if (closed || edits === undefined) return

			edits.define({ context, styles: await partXml(open, "styles"), numbering: await partXml(open, "numbering") })

			const slicing: Slicing = {
				pause: engineServices.yield,
				sliceMs: engineServices.sliceMs ?? 12,
				now: engineServices.now ?? (() => Date.now())
			}
			const made = editing.proof?.(context)
			const split = made !== undefined && "later" in made ? made : undefined
			const proof = made === undefined || !("later" in made) ? made : made.first

			priority.hold(open.layout)

			// With a proof the body is proved below, in slices; other stories prove as their sessions start.
			const bodyOptions = proof === undefined ? (editing.session ?? {}) : { ...editing.session, proof: null }
			// Built in slices: a long document opens without long tasks.
			const session = await DocxEditorSession.open(context, bodyOptions, slicing)

			if (closed) return

			let storyProof = proof

			if (split !== undefined) {
				const verdicts = await verdictsInSlices(session, split.first, slicing, () => closed)

				if (verdicts === undefined) return

				// The layout goes on while the rest of the proof comes.
				priority.release()

				const later = await split.later

				if (closed) return

				priority.hold(open.layout)

				const extra = later.extra

				proofLocked = await proveInSlices(
					session,
					{ check: (node, story) => extra.check(node, story) ?? verdicts.get(node) },
					slicing,
					() => closed
				)
				storyProof = later.full
			} else if (proof !== undefined) proofLocked = await proveInSlices(session, proof, slicing, () => closed)

			const storyOptions = storyProof === undefined ? editing.session : { ...editing.session, proof: storyProof }

			if (closed) return

			// A long body's review index is read now, in slices, not in the task that first needs it.
			await prepareStoryReviewIndex(session, slicing, () => closed)

			if (closed) return

			priority.release()

			const editor = new PagedEditor({
				session,
				edits,
				layout: open.layout,
				tester: new HitTester(open.layout.styles),
				...(editing.paged === undefined ? {} : { options: editing.paged }),
				...(storyOptions === undefined ? {} : { sessionOptions: storyOptions })
			})

			paged = editor
			current = editor
			holdMerges = () => editor.edits.holdCompaction()
			writing = {
				// A save under way when the document closes stops at its next turn.
				slicing: {
					sliceMs: slicing.sliceMs,
					now: slicing.now,
					pause: async () => {
						await slicing.pause()

						if (closed) throw new DocxClosedError()
					}
				},
				zipper: (editing.writer?.zipper ?? inThreadDocxZipper)(open.pkg.opc)
			}
			saveInput = {
				pkg: open.pkg,
				context,
				get sessions() {
					return editor.sessions
				}
			}
			// Pages laid out again go to the renderer like any others.
			editor.subscribe(event => {
				if (event.type === "pages" && !closed) engine.shipPages(event.changed, event.final)
			})
			resolve(editor)
		}

		liveEngine = engine
		void engine.run()

		return {
			objects: ids => engine.objects(ids),
			media: partName => engine.media(partName),
			locate: anchor => engine.locate(anchor),
			find: (query, findOptions) => engine.find(query, findOptions),
			annotations: () => engine.annotations(),
			close() {
				closed = true
				current = undefined
				saveInput = undefined
				writing?.zipper.dispose()
				writing = undefined
				holdMerges = () => () => undefined
				paged?.dispose()
				paged?.session.dispose()
				priority.release()
				engine.close()
				liveEngine = undefined
				reject(new Error("closed"))
			}
		}
	}

	return {
		host,
		editor,
		saveInput: flushed,
		save,
		prepare: sessions => held(() => prepare(sessions, false)),
		proofLocked: () => proofLocked,
		setAuthor(name) {
			author = name

			if (current !== undefined) {
				const identity = current.body.session.context.identity

				identity.author = name
				identity.initials = name === undefined ? undefined : authorInitials(name)

				for (const session of current.sessions) session.invalidate()
			}
		},
		setView(view) {
			return (
				current?.setView(
					view === "original" ? RevisionView.Original : view === "markup" ? RevisionView.Markup : RevisionView.Final
				) ?? false
			)
		},
		addMedia: (chunks, info) => current?.addMedia(chunks, info),
		pdfSource: async signal =>
			(await liveEngine?.pdfFinalSource((current?.view ?? RevisionView.Final) === RevisionView.Final, signal)) ?? undefined,
		releaseMedia(handle) {
			const live = saveInput

			if (live === undefined) return

			settleMedia(live.context, [handle])

			if (!mediaInUse(live.sessions.map(session => session.state)).has(handle)) live.context.media.release(handle)
		}
	}
}
