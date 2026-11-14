import { estimateSavePeak, fitsBudget, type PdfMemoryProfile } from "./budget"
import { signatureAllows, type PdfSignatureState, type PdfToolClass } from "./signaturePolicy"

// How a document is written, decided before anything is written. A signed document is saved incrementally (its
// signed byte ranges stay as they are) when every change made is one its signers allowed. Everything else is a full
// rewrite with unused objects dropped: an incremental save of an unsigned document would keep deleted pages,
// annotations and text in the revision before it, readable by anyone with the file. Encryption is kept as it is. A
// save is refused when a rewrite would break signatures the user did not agree to break, when its memory estimate
// passes the engine's budget, or when the engine is poisoned.

export type PdfSaveMode = "incremental" | "full"

export type PdfSaveRefusal =
	// The engine hit a trap or ran out of memory: its document is not trustworthy.
	| "poisoned"
	// Writing needs more memory than this browser allows for a file this size.
	| "overBudget"
	// A rewrite would invalidate signatures; asked first.
	| "invalidatesSignatures"

export interface PdfSaveInput {
	// The open file's size.
	readonly inputBytes: number
	readonly signatures: PdfSignatureState
	// Kinds of change made since opening.
	readonly changes: readonly PdfToolClass[]
	// The user agreed to invalidate the signatures (a save that breaks them).
	readonly invalidateConfirmed: boolean
	readonly poisoned: boolean
	readonly memory: PdfMemoryProfile
}

export interface PdfSavePlan {
	readonly mode: PdfSaveMode
	// Encryption is never changed by a plain save.
	readonly encryption: "keep"
	// Signature fields the save invalidates (a rewrite of a signed document).
	readonly invalidates: readonly string[]
	// The heap the save is expected to reach.
	readonly peakBytes: number
	// MuPDF's write options.
	readonly options: string
	readonly refuse: PdfSaveRefusal | null
}

export const PDF_FULL_SAVE_OPTIONS = "garbage=compact,objstms,compress,encrypt=keep"
// No object streams: a reader that never learned them still reads the signed revisions, and the appended one stays
// plain to check.
export const PDF_INCREMENTAL_SAVE_OPTIONS = "incremental,encrypt=keep"

export function planSave(input: PdfSaveInput): PdfSavePlan {
	const signed = input.signatures.fields.length > 0
	const incremental = signed && input.changes.every(change => signatureAllows(input.signatures, change))
	const invalidates = signed && !incremental ? input.signatures.fields : []
	const peakBytes = estimateSavePeak(input.inputBytes, false)
	const refuse: PdfSaveRefusal | null = input.poisoned
		? "poisoned"
		: !fitsBudget(peakBytes, input.memory)
			? "overBudget"
			: invalidates.length > 0 && !input.invalidateConfirmed
				? "invalidatesSignatures"
				: null

	return {
		mode: incremental ? "incremental" : "full",
		encryption: "keep",
		invalidates,
		peakBytes,
		options: incremental ? PDF_INCREMENTAL_SAVE_OPTIONS : PDF_FULL_SAVE_OPTIONS,
		refuse
	}
}
