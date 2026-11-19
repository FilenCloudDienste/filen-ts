// Why a save was refused, in a module of its own: the zip half of a save runs where the editor does not (a
// worker) and must not pull the writer in.

export type VerifyFailure =
	| "invalidPackage"
	| "untouchedChanged"
	| "malformedPart"
	| "contentType"
	| "relationship"
	| "duplicateId"
	| "danglingReference"
	| "model"
	| "content"

export class DocxVerifyError extends Error {
	readonly reason: VerifyFailure
	// What the refusal compared, for tests and local debugging. It may hold document content, so it is never part
	// of `message` (which is logged) and not enumerable (not copied by a spread or a structured log).
	declare readonly detail?: string

	constructor(reason: VerifyFailure, message: string, detail?: string) {
		super(message)
		this.name = "DocxVerifyError"
		this.reason = reason

		if (detail !== undefined) Object.defineProperty(this, "detail", { value: detail, enumerable: false })
	}
}

export type DocxSaveFailure = "readOnly" | "write" | VerifyFailure

const FAILURES: ReadonlySet<string> = new Set<DocxSaveFailure>([
	"readOnly",
	"write",
	"invalidPackage",
	"untouchedChanged",
	"malformedPart",
	"contentType",
	"relationship",
	"duplicateId",
	"danglingReference",
	"model",
	"content"
])

export function isDocxSaveFailure(value: unknown): value is DocxSaveFailure {
	return typeof value === "string" && FAILURES.has(value)
}

export class DocxSaveError extends Error {
	readonly reason: DocxSaveFailure

	constructor(reason: DocxSaveFailure, message: string) {
		super(message)
		this.name = "DocxSaveError"
		this.reason = reason
	}
}
