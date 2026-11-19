import { MessageChannel, type MessagePort } from "node:worker_threads"
import { unzipSync } from "fflate"
import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { docxSchema } from "@filen/office/core/docx/edit"
import { prepareDocxSave, writerProof } from "@filen/office/core/docx/write"
import { bytesSource } from "@filen/office/core/opc"
import {
	docxWorkerPool,
	inThreadDocxProtection,
	serveDocxWorker,
	type DocxWorkerPool,
	type DocxDocumentUnlock,
	type DocxEngineServices,
	type DocxLockedDocument,
	type DocxProtection,
	type DocxUnlockedDocument
} from "@filen/office/dom/docx"
import { docxSealer, inThreadEditingHost, type DocxWritten } from "@filen/office/dom/docx/editing"
import { encryptedOfficeFile } from "@filen/office/testing/encryption"
import { engineServices } from "./engineFixtures"

// Opening, editing and saving password-protected documents through the hosts the apps use.

export function services(): DocxEngineServices {
	return engineServices({
		yield: () => new Promise(resolve => setTimeout(resolve, 0)),
		sliceMs: 50
	})
}

export const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

// What leaves a save for upload: the test hook every encrypted save goes through.
export function expectSealedUpload(bytes: Uint8Array): void {
	if (!CFB_SIGNATURE.every((byte, k) => bytes[k] === byte)) throw new Error("an encrypted document's save is not a compound file")
	if (bytes[0] === 0x50 && bytes[1] === 0x4b) throw new Error("an encrypted document's save is a zip")
}

export const encryptedFile = encryptedOfficeFile

// Password protection on the test's thread (the same interface as the docx worker pool's).
export const PROTECTION: DocxProtection = inThreadDocxProtection(() => services())

export async function lockedOf(file: Uint8Array, protection: DocxProtection = PROTECTION): Promise<DocxLockedDocument> {
	const opened = await protection.open(bytesSource(file))

	if (opened.kind !== "needsPassword") throw new Error(`expected a password prompt, got ${opened.kind}`)

	return opened.locked
}

export function decrypted(result: DocxDocumentUnlock): DocxUnlockedDocument {
	if (!result.ok) throw new Error(`unlock failed: ${result.reason}`)

	return result.document
}

// Opens `file` with `password`: the unlocked document, held where the protection keeps it.
export async function unlockFile(
	file: Uint8Array,
	password: string,
	protection: DocxProtection = PROTECTION
): Promise<DocxUnlockedDocument> {
	return decrypted(await (await lockedOf(file, protection)).unlock(password))
}

// The decrypted package of `file`: a copy taken from where it is held, the document released.
export async function plaintextOf(file: Uint8Array, password: string): Promise<Uint8Array> {
	const document = await unlockFile(file, password)

	try {
		return (await document.take()).bytes
	} finally {
		document.release()
	}
}

// The first place in the body where text can be typed: inside a paragraph's existing text.
function firstTextPosition(doc: Node): number | undefined {
	let found: number | undefined

	doc.descendants((node, pos, parent) => {
		if (found !== undefined) return false
		if (node.type === docxSchema.nodes["locked_block"]) return false
		if (node.isText && parent?.type === docxSchema.nodes["paragraph"] && (node.text ?? "").length > 0) found = pos

		return true
	})

	return found
}

export interface EditedSave {
	readonly unedited: DocxWritten
	// Undefined when the body has no editable text.
	readonly edited: DocxWritten | undefined
}

// Takes the unlocked document to this thread as an editor does, opens it in an editing host sealing with its
// key, saves it unedited, then types `marker` into the first editable text and saves again.
// `writeUnlocked`: the password to modify was given (a write-protected document saves only then).
export async function editAndSave(document: DocxUnlockedDocument, marker: string, writeUnlocked = false): Promise<EditedSave> {
	const taken = await document.take()
	const { sealer, release } = docxSealer(taken)
	const editing = inThreadEditingHost(() => services(), {
		proof: writerProof,
		writer: { prepare: prepareDocxSave },
		encryption: sealer,
		writeUnlocked
	})
	const session = editing.host(bytesSource(taken.bytes), () => undefined)

	try {
		const editor = await editing.editor
		const unedited = await editing.save()
		const at = firstTextPosition(editor.state.doc)

		if (at === undefined) return { unedited, edited: undefined }

		editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)).insertText(marker))

		return { unedited, edited: await editing.save() }
	} finally {
		session.close()
		release()
	}
}

export function documentXml(zip: Uint8Array): string {
	const part = unzipSync(zip, { filter: file => file.name === "word/document.xml" })["word/document.xml"]

	return part === undefined ? "" : new TextDecoder().decode(part)
}

export interface WorkerHarness {
	readonly pool: DocxWorkerPool
	// Every message the "worker" posted to the page, as the page received it (a structured clone).
	readonly received: unknown[]
	readonly terminated: () => number
	dispose(): void
}

// The docx worker on a MessagePort pair (structured clone both ways, CryptoKeys included), as the web runs it.
export function workerHarness(idleMs = 60_000): WorkerHarness {
	const received: unknown[] = []
	let terminated = 0
	const ports: MessagePort[] = []
	const pool = docxWorkerPool(() => {
		const { port1: page, port2: worker } = new MessageChannel()

		ports.push(page, worker)
		serveDocxWorker(
			{
				post: (message, transfer) => worker.postMessage(message, [...transfer]),
				listen: onMessage => worker.on("message", onMessage)
			},
			() => services()
		)

		return {
			post: (message, transfer) => page.postMessage(message, [...transfer]),
			listen(onMessage) {
				page.on("message", data => {
					received.push(data)
					onMessage(data)
				})
			},
			terminate() {
				terminated++
				page.close()
				worker.close()
			}
		}
	}, idleMs)

	return {
		pool,
		received,
		terminated: () => terminated,
		dispose() {
			pool.dispose()

			for (const port of ports) port.close()
		}
	}
}
