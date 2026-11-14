import type * as Mupdf from "mupdf"
import { estimateSavePeak, fitsBudget } from "../../core/pdfedit/budget"
import { PDF_FULL_SAVE_OPTIONS, PDF_INCREMENTAL_SAVE_OPTIONS, type PdfSavePlan } from "../../core/pdfedit/savePlan"
import { composeWriteOptions } from "../../core/pdfedit/security"
import { pendingSignature } from "./commands/sign"
import { PdfEngineRefusal, type PdfEngineContext } from "./context"
import { createPdfDigest } from "./digest"
import { changed, editing, idle, rebuild, type Editing } from "./editRequests"
import type { PdfSignAnswer, PdfSignPort } from "./protocol"
import type { PdfRequestHandler } from "./requests"
import { PdfSignRefusal, signPdfDocument, type PdfSignedRevision } from "./sign"

// The signing save: the signature placed by sign.addField is signed as the last step of a save, and the signed file
// is held like any save's output until saveEnd. Unsaved changes of an unsigned document go into the same file: the
// document is first rewritten whole into the heap (an incremental save would keep what they removed readable in the
// revision before), the rewrite is opened in place, and the signature is appended to it as a revision; the document
// itself stays as it was. Otherwise (no other changes, or a signed document, whose changes its signers allowed) the
// signature is appended to the document's own file, which spends the document (MuPDF takes the output as its file):
// a kept save opens the output in place (saveEnd), a dropped one rebuilds it (signDiscard).

type SignOp = "signBegin" | "signDiscard"

type Handlers = { readonly [K in SignOp]: PdfRequestHandler<K> }

// The CMS for a digest, asked of the page on `port` (answers arrive in order, one per question).
function signerOf(port: PdfSignPort): (digest: Uint8Array) => Promise<Uint8Array> {
	const waiting: ((answer: PdfSignAnswer) => void)[] = []

	port.addEventListener("message", event => {
		const data = event.data as PdfSignAnswer | null
		const answer: PdfSignAnswer =
			typeof data === "object" && data !== null && "cms" in data && data.cms instanceof Uint8Array
				? { cms: data.cms }
				: { error: typeof data === "object" && data !== null && "error" in data ? String(data.error) : "malformed answer" }

		waiting.shift()?.(answer)
	})
	port.start?.()

	return digest =>
		new Promise((resolve, reject) => {
			waiting.push(answer => {
				if ("cms" in answer) resolve(answer.cms)
				else reject(new Error(answer.error))
			})
			port.postMessage({ digest })
		})
}

// Opens a written file in the heap in place, unlocked, for the signing save only (no journal, no scripts).
function openWritten(context: PdfEngineContext, buffer: Mupdf.Buffer, password: string | undefined): Mupdf.PDFDocument {
	const opened = context.mupdf.Document.openDocument(buffer, "application/pdf").asPDF()

	if (opened === null || (opened.needsPassword() && (password === undefined || opened.authenticatePassword(password) === 0))) {
		opened?.destroy()

		throw new PdfEngineRefusal("failed", "the written file did not open")
	}

	if (opened.isJSSupported()) opened.disableJS()

	return opened
}

function placeholderCapacity(document: Mupdf.PDFDocument, signatureNum: number): number {
	const contents = document.newIndirect(signatureNum).get("Contents")

	if (!contents.isString()) throw new PdfEngineRefusal("failed", "the placeholder has no contents")

	return contents.asByteString().length
}

function revisionsOf(context: PdfEngineContext, buffer: Mupdf.Buffer): number {
	const probe = context.mupdf.Document.openDocument(buffer, "application/pdf").asPDF()

	if (probe === null) throw new PdfEngineRefusal("failed", "the signed file did not open")

	try {
		return probe.countVersions()
	} finally {
		probe.destroy()
	}
}

// Signs `document` (whose file is `baseLength` bytes) with its pending placeholder; the output is the file plus the
// signature's revision.
async function signOn(
	context: PdfEngineContext,
	open: Editing,
	document: Mupdf.PDFDocument,
	baseLength: number,
	sign: (digest: Uint8Array) => Promise<Uint8Array>,
	digest: Parameters<typeof signPdfDocument>[3]["digest"]
): Promise<{ readonly revision: PdfSignedRevision; readonly field: string }> {
	const pending = pendingSignature(document)

	if (pending === null) throw new PdfEngineRefusal("badRequest", "no signature is placed")

	const revision = await signPdfDocument(
		context.mupdf,
		document,
		{ pages: [], field: pending.field, signatureNum: pending.signatureNum },
		{
			baseLength,
			capacity: placeholderCapacity(document, pending.signatureNum),
			digest,
			createDigest: createPdfDigest,
			sign,
			password: open.edit.password ?? null
		}
	).catch((error: unknown) => {
		throw error instanceof PdfSignRefusal ? new PdfEngineRefusal("notAllowed", `sign.${error.reason}`) : error
	})

	return { revision, field: pending.field }
}

export const SIGN_REQUESTS: Handlers = {
	signBegin: async (context, { inputBytes, memory, digest, signer }) => {
		const open = editing(context)
		const { document, edit } = open

		idle(edit)
		edit.endOpen(document)

		const last = edit.log[edit.applied - 1]

		if (last?.label !== "sign.addField" || pendingSignature(document) === null)
			throw new PdfEngineRefusal("badRequest", "no signature is placed")

		// Unsaved changes besides the signature, in an unsigned document: rewritten first, into the same file.
		const rewrite = edit.signatures.fields.length === 0 && edit.savedApplied !== edit.applied - 1
		const peakBytes = estimateSavePeak(inputBytes, rewrite)

		if (!fitsBudget(peakBytes, memory)) return { value: { status: "refused", reason: "overBudget" } }

		const sign = signerOf(signer)
		let signed: { readonly revision: PdfSignedRevision; readonly field: string }

		// Whatever happens from here, the journal cannot undo across the writes.
		edit.written()

		try {
			if (rewrite) {
				const written = document.saveToBuffer(composeWriteOptions(PDF_FULL_SAVE_OPTIONS, { encrypt: "keep" }))

				try {
					const opened = openWritten(context, written, edit.password)

					try {
						signed = await signOn(context, open, opened, written.getLength(), sign, digest)
					} finally {
						opened.destroy()
					}
				} finally {
					written.destroy()
				}
			} else {
				const baseLength = open.source?.getLength() ?? open.reader.length

				signed = await signOn(context, open, document, baseLength, sign, digest)
			}
		} finally {
			signer.close()
		}

		const plan: PdfSavePlan = {
			mode: "incremental",
			encryption: "keep",
			invalidates: [],
			peakBytes,
			options: PDF_INCREMENTAL_SAVE_OPTIONS,
			refuse: null
		}
		const { revision, field } = signed

		edit.output = {
			buffer: revision.buffer,
			plan,
			serving: [],
			previousSaved: edit.savedApplied,
			security: null,
			encryption: edit.encryption,
			resets: false
		}
		edit.savedApplied = edit.applied
		context.mupdf.shrinkStore(50)

		return {
			value: {
				status: "written",
				size: revision.buffer.getLength(),
				versions: revisionsOf(context, revision.buffer),
				field,
				byteRange: [...revision.byteRange]
			}
		}
	},
	signDiscard: context => {
		const open = editing(context)
		const { edit } = open

		idle(edit)
		edit.endOpen(open.document)

		if (edit.log[edit.applied - 1]?.label !== "sign.addField") return { value: changed(open, []) }

		// Taken back as a step back would (a document a signing save spent is rebuilt), and never redone.
		edit.undo(open.document, count => {
			rebuild(context, open, count)
		})
		edit.log.length = edit.applied
		edit.pagesChanged()

		const after = editing(context)

		return {
			value: changed(
				after,
				Array.from({ length: after.document.countPages() }, (_, index) => index)
			)
		}
	}
}
