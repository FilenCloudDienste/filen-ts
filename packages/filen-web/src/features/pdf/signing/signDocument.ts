import { estimateSavePeak, fitsBudget, type PdfMemoryProfile } from "@filen/office/core/pdfedit"
import type { PdfDigestName } from "@filen/office/core/pdfsign"
import type { PdfSignatureFieldHint } from "@filen/office/dom/pdf"
import type { PdfSignFieldArgs } from "@filen/office/dom/pdfedit"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { PdfSigner } from "@/features/pdf/signing/signerClient"
import type { PdfSignerSummary } from "@/features/pdf/workers/pdfSignerCore"
import { log } from "@/lib/log"

// Signing with a certificate, from the placed signature to the saved file. Unsaved changes go into the signed file
// when the rewrite they need and the signing save fit the engine's memory together (one new version); otherwise they
// are saved first as a version of their own, then the signed version (the user is told). The signature is placed (one
// step, sign.addField), then the save signs it as its last step: the signer worker makes the CMS, our verifier checks
// the written file (the new signature unchanged) before anything is uploaded, and the signer is terminated (its key
// goes with it) whatever happened. A signature not saved goes again (signDiscard), so no placeholder ever stays.

export interface PdfSigningRequest {
	readonly signer: PdfSigner
	readonly summary: PdfSignerSummary
	// Where and how the signature shows; its /M time and /Contents room are added here.
	readonly field: Omit<PdfSignFieldArgs, "capacity" | "time">
}

// What a signing save needs besides a plain save's dependencies (pdfSave.ts signPdfVersion).
export interface PdfSignedSaveJob {
	readonly signer: PdfSigner
	readonly digest: PdfDigestName
	// The signatures of the file the signature is appended to, as the viewer's parser saw them (pdf.js), or the
	// engine's own reading of a file a save here wrote: the verifier cross-checks its reading against them. Null when
	// pdf.js could not tell.
	readonly hints: () => Promise<readonly PdfSignatureFieldHint[] | null>
}

export interface PdfSigningDeps {
	readonly session: <T>(read: (session: PdfEditSessionModel) => Promise<T>) => Promise<T>
	// The open file's size.
	readonly fileSize: () => number
	readonly memory: PdfMemoryProfile
	// Saves a new version (the preview overlay's Save), signing as its last step with `job`; true once saved.
	readonly save: (job: PdfSignedSaveJob | null) => Promise<boolean>
	readonly job: (signer: PdfSigner, digest: PdfDigestName) => PdfSignedSaveJob
	// The changes are saved as a version of their own first.
	readonly onSaveChangesFirst: () => void
	readonly onFailed: (error: unknown) => void
}

// Whether the unsaved changes and the signature can go into one file.
export function signsInOneVersion(dirty: boolean, signed: boolean, fileSize: number, memory: PdfMemoryProfile): boolean {
	const rewrite = dirty && !signed

	return !rewrite || fitsBudget(estimateSavePeak(fileSize, true), memory)
}

export async function signWithCertificate(deps: PdfSigningDeps, request: PdfSigningRequest): Promise<boolean> {
	const { signer, summary } = request
	let placed = false

	try {
		const state = await deps.session(session => Promise.resolve(session.getSnapshot().state))

		// New protection and redactions are saved by a plain Save first (the signing save refuses them).
		const saveFirst =
			state.security.pending !== null ||
			state.redacting ||
			!signsInOneVersion(state.dirty, state.signatures.fields.length > 0, deps.fileSize(), deps.memory)

		if (saveFirst) {
			deps.onSaveChangesFirst()

			if (!(await deps.save(null))) return false
		}

		await deps.session(session => session.dispatch("sign.addField", { ...request.field, time: Date.now(), capacity: summary.capacity }))
		placed = true

		const saved = await deps.save(deps.job(signer, summary.digest))

		if (saved) placed = false

		return saved
	} catch (error) {
		log.warn("pdf", "signing failed", { error })
		deps.onFailed(error)

		return false
	} finally {
		signer.terminate()

		if (placed) {
			await deps
				.session(session => session.discardSignature())
				.catch((error: unknown) => {
					log.warn("pdf", "the unsigned signature was not removed", { error })
				})
		}
	}
}
