import type { Node } from "prosemirror-model"
import { findUnsavableBlocks, type DocxEditorSession } from "@filen/office/core/docx/edit"
import { DocxSaveError, prepareDocxSave, writerProof } from "@filen/office/core/docx/write"
import type { ConvertEdited } from "@/features/preview/lib/docxLiveFile"
import { OFFICE_HYPHENATION_URLS } from "virtual:office-hyphenation"
import { fetchFontAssets, hyphenationLibrary, windowServices, type DocxUnlockedDocument } from "@filen/office/dom/docx"
import {
	docxSealer,
	inThreadEditingHost,
	isSealedOfficeFile,
	type DocxEditingHost,
	type DocxEditingOptions,
	type DocxEditingWriter,
	type DocxSealer
} from "@filen/office/dom/docx/editing"
import { docxZipWorker, type DocxSaveNotice } from "@filen/office/dom/docx/save"
import { plainText } from "@filen/office/react/docx/editor"
import { DOCX_FONT_URLS } from "@/features/preview/lib/docxEngine"
import DocxZipWorker from "@/features/preview/workers/docxZip.worker.ts?worker"
import { recoverIfNewerBuild } from "@/lib/appUpdate"
import { log } from "@/lib/log"

// Editing a Word document on the page's own thread (the viewer stays in its worker): model, layout and the
// editing session in one realm, laid out again as far as the pages in view on each keystroke. Every block is
// proved to save as it was opened (the writer's Gate 1) while the document opens; a block that would not
// is locked and the rest stays editable. A save writes and checks the edited parts here in slices (the page
// stays responsive), then deflates them into the file and checks that in a worker of the document's own.

const zipper = docxZipWorker(() => {
	const worker = new DocxZipWorker()

	return {
		post(message, transfer) {
			worker.postMessage(message, [...transfer])
		},
		listen(onMessage, onError) {
			worker.addEventListener("message", event => {
				onMessage(event.data)
			})
			worker.addEventListener("error", () => {
				// A deploy that changed this worker removes its old file (appUpdate.ts).
				recoverIfNewerBuild()
				onError()
			})
			// A message that could not be read leaves its zip waiting for ever: end the worker.
			worker.addEventListener("messageerror", onError)
		},
		terminate() {
			worker.terminate()
		}
	}
})

// What a document of another format edits through (an RTF document, rtfEditing.ts): its Gate 1 and its writer.
export interface DocxEditingBackend {
	readonly proof: NonNullable<DocxEditingOptions["proof"]>
	readonly writer: DocxEditingWriter
	// The document's edits converted to .docx where it is held, without its own writer (an ODT document, for Download as).
	readonly convertEdited?: ConvertEdited
	// What the file shows that the package edited leaves out (an RTF's equations), for the PDF's report.
	readonly untranslated?: number
	// What makes the document view-only that the package edited does not say (a signed ODT): saved as a new file only.
	readonly gate?: DocxEditingOptions["gate"]
}

// `writeUnlocked`: the document's password to modify was given (docxWriteProtection.tsx). `encryption`: it was
// opened with its password (docxViewer.tsx): every save is sealed with its key after the zip and checked.
// `backend`: the proof and writer of a document saved in another format (default: the docx writer's).
// `protectionUnlocked`: the user stopped the protection that kept it view-only (docxRestrictEditing.tsx).
export function docxEditingHost(
	writeUnlocked = false,
	encryption?: DocxSealer,
	backend?: DocxEditingBackend,
	protectionUnlocked = false
): DocxEditingHost {
	return inThreadEditingHost(
		options => windowServices(window, fetchFontAssets(options.fontUrls ?? DOCX_FONT_URLS), hyphenationLibrary(OFFICE_HYPHENATION_URLS)),
		{
			proof: backend?.proof ?? writerProof,
			writer: backend?.writer ?? { prepare: prepareDocxSave, zipper },
			writeUnlocked,
			...(protectionUnlocked ? { protectionUnlocked } : {}),
			...(encryption === undefined ? {} : { encryption }),
			...(backend?.gate === undefined || backend.gate.length === 0 ? {} : { gate: backend.gate })
		}
	)
}

// A password-protected document as the editor holds it: its own copy of the decrypted package (taken from where
// the viewer's engine holds it) and a sealer whose key comes from there at the first seal. `close` releases the key once no seal
// still runs (a save that started finishes sealed).
export interface DocxTakenSession {
	readonly bytes: Uint8Array
	readonly sealer: DocxSealer
	close: () => void
}

export async function takeProtectedDocument(document: DocxUnlockedDocument, signal: AbortSignal): Promise<DocxTakenSession> {
	const taken = await document.take({ signal })
	// The key is asked for at the first seal (a session that never saves never derives or moves it).
	const held = docxSealer(taken)
	const sealer = held.sealer
	let open = true
	let sealing = 0
	const releaseIfIdle = (): void => {
		if (!open && sealing === 0) {
			held.release()
		}
	}

	return {
		bytes: taken.bytes,
		sealer: {
			get released() {
				return sealer.released
			},
			async seal(zip, options) {
				sealing++

				try {
					return await sealer.seal(zip, options)
				} finally {
					sealing--
					releaseIfIdle()
				}
			}
		},
		close: () => {
			open = false
			releaseIfIdle()
		}
	}
}

// What a save of a password-protected document hands to the upload must be sealed (a compound file, never
// the decrypted zip): checked once more right before it leaves the editor.
export class DocxPlaintextUploadError extends Error {
	constructor() {
		super("A password-protected document's save is not sealed")

		this.name = "DocxPlaintextUploadError"
	}
}

export function assertSealedUpload(bytes: Uint8Array, encrypted: boolean): void {
	if (encrypted && !isSealedOfficeFile(bytes)) {
		throw new DocxPlaintextUploadError()
	}
}

// The file as edited, and the call that marks exactly what it holds saved once stored.
export interface DocxSaveSnapshot {
	bytes: Uint8Array
	// Once the file is stored: marks what it holds saved (and takes back the blocks below, as written).
	commit: () => void
	// Time spent writing and checking the file (ms), for the log.
	elapsedMs: number
	// Edited blocks the writer could not write as edited, written as they were last saved (decision 5): how
	// many, and their edited text (the user may keep it; an undo after the save brings it back too).
	// `reverted`: how many the editor took back in commit() (0 until then; fewer when some were edited
	// while the file was stored, which keep those edits, unsaved).
	locked?: { count: number; text: string; reverted: number }
	// What the file's own writer wrote otherwise than the edit has it, for the user to be told once it is stored.
	notices?: readonly DocxSaveNotice[]
}

export interface WriteDocxOptions {
	// An idle autosave: a refusal is reported as is (no search, nothing taken back).
	auto?: boolean
	// The search for blocks the writer refuses is starting (it runs the writer several times).
	onSearch?: () => void
}

// Refusals no taken-back block resolves, by the documents refused: the same state is refused again at once.
const refusedStates = new WeakMap<DocxEditingHost, { docs: readonly unknown[]; error: DocxSaveError }>()
// Plan-level refusals (Gate 2's part checks, or the writer itself): about what the edits wrote.
const ZIP_REASONS: ReadonlySet<string> = new Set(["invalidPackage", "untouchedChanged"])
const SEARCH_RUNS = 24
const SEARCH_BUDGET_MS = 20_000

function sameDocs(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((doc, k) => doc === b[k])
}

// Writes `write` (the sessions to write: `live`, or stand-ins for them) and returns the file with its commit.
async function writeOnce(
	host: DocxEditingHost,
	live: readonly DocxEditorSession[],
	write: readonly DocxEditorSession[],
	started: number
): Promise<DocxSaveSnapshot> {
	const written = write.map(session => session.state.doc)
	const tracking = live[0]?.context.review.tracking
	const protection = live[0]?.context.protectionChange
	const result = await host.save(write)

	return {
		bytes: result.bytes,
		commit: () => {
			live.forEach((session, index) => {
				const doc = written[index]

				if (doc !== undefined) {
					session.markSaved(doc, tracking, protection)
				}
			})
		},
		elapsedMs: performance.now() - started,
		...(result.notices === undefined ? {} : { notices: result.notices })
	}
}

// Whether the writer accepts the document as these sessions hold it (its own checks, in slices; nothing zipped
// or stored).
function writerAccepts(host: DocxEditingHost, sessions: readonly DocxEditorSession[]): Promise<boolean> {
	return host.prepare(sessions).then(
		() => true,
		(error: unknown) => {
			if (error instanceof DocxSaveError) {
				return false
			}

			throw error
		}
	)
}

// Writes the edited document: the lossless writer (every untouched part copied byte for byte, the edited
// stories written from their sessions) and the part checks in slices on this thread, then the browser's own
// deflate for the rewritten parts and the written file read back and checked in the zip worker (Gate 2). When the writer refuses an explicit save, the edited blocks it cannot
// write are found and the file is written with them as they were last saved; the editor takes them back only
// in commit(), once the file is stored (an undoable step). A refusal no block resolves (remembered for that
// state), or any refusal of an autosave, throws the writer's DocxSaveError, the document left as it was.
export async function writeDocx(host: DocxEditingHost, options: WriteDocxOptions = {}): Promise<DocxSaveSnapshot> {
	const input = host.saveInput()

	if (input === undefined) {
		throw new Error("The document is not open for editing")
	}

	const started = performance.now()
	const sessions = [...input.sessions]
	const docs = sessions.map(session => session.state.doc)
	const refused = refusedStates.get(host)

	if (refused !== undefined && sameDocs(refused.docs, docs)) {
		throw refused.error
	}

	// The editor stays editable while the file is written: the writer reads the documents once, as it starts, and
	// the search below works on them as they were then (stand-ins), so typing meanwhile moves nothing it found.
	const frozen = sessions.map(session => session.withTransaction(session.state.tr))

	try {
		return await writeOnce(host, sessions, sessions, started)
	} catch (error) {
		if (!(error instanceof DocxSaveError) || error.reason === "readOnly" || options.auto === true) {
			throw error
		}

		options.onSearch?.()

		const found = await findUnsavableBlocks(frozen, trial => writerAccepts(host, trial), {
			maxAttempts: SEARCH_RUNS,
			budgetMs: SEARCH_BUDGET_MS,
			refused: !ZIP_REASONS.has(error.reason),
			pause: () => new Promise(resolve => setTimeout(resolve, 0))
		})

		if (found === null) {
			refusedStates.set(host, { docs, error })

			throw error
		}

		// The blocks as the save found them, taken back in the live session wherever they still are.
		const blocks = new Map<DocxEditorSession, (Node | null)[]>()

		for (const { session, positions } of found) {
			const live = sessions[frozen.indexOf(session)]

			if (live !== undefined) {
				blocks.set(
					live,
					positions.map(pos => session.state.doc.nodeAt(pos))
				)
			}
		}
		const text = found
			.flatMap(({ session, positions }) =>
				positions.map(pos => plainText(session.state.doc, pos, pos + (session.state.doc.nodeAt(pos)?.nodeSize ?? 0), () => ""))
			)
			.join("\n")
		const write = frozen.map(session => {
			const positions = found.find(entry => entry.session === session)?.positions

			return positions === undefined ? session : session.withReverted(positions)
		})
		const written = await writeOnce(host, sessions, write, started)
		const count = found.reduce((sum, { positions }) => sum + positions.length, 0)

		log.warn("docx", "edited blocks written as last saved", { count, reason: error.reason, message: error.message })

		const locked = { count, text, reverted: 0 }

		return {
			...written,
			commit: () => {
				// What was stored: those blocks as last saved (an edit made to one since stays, unsaved).
				for (const [session, nodes] of blocks) {
					locked.reverted += session.revert(nodes.filter(node => node !== null))
				}

				written.commit()
			},
			locked
		}
	}
}
