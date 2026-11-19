// Why a save was refused. The writer and the gate throw XlsxWriteError inside; saveXlsx turns every failure
// into a refusal and never throws.

export type XlsxSaveFailure =
	// Nothing to write from (a sheet to rewrite is not loaded), or the model holds what the file cannot (NaN).
	| "write"
	// The zip half of the gate: the written archive, untouched entries and changed ones.
	| "invalidPackage"
	| "untouchedChanged"
	// The part half: well-formed XML, schema order, content types, relationships, references in range.
	| "malformedPart"
	| "elementOrder"
	| "contentType"
	| "relationship"
	| "reference"
	// The independent re-read of the written parts differs from the session model.
	| "model"

export class XlsxWriteError extends Error {
	readonly reason: XlsxSaveFailure

	constructor(reason: XlsxSaveFailure, message: string) {
		super(message)
		this.name = "XlsxWriteError"
		this.reason = reason
	}
}

export interface XlsxSaveRefusal {
	readonly ok: false
	readonly reason: XlsxSaveFailure
	readonly message: string
}
