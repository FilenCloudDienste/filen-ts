import type { PdfChangeKind } from "./types"

// Which changes after a signature its signer allowed. A certification (DocMDP) sets the level for the whole document:
// 1 nothing, 2 form filling and signing, 3 also annotations. Field locks (FieldMDP, a field's /Lock) forbid changing the
// listed fields. Without a certification, form filling, signing and annotations are allowed; content never is.

export type PdfCertificationLevel = 1 | 2 | 3

export interface PdfFieldLock {
	readonly action: "All" | "Include" | "Exclude"
	readonly fields: readonly string[]
}

export interface PdfChange {
	readonly kind: PdfChangeKind
	// The fully qualified field a form change belongs to.
	readonly field?: string
}

export function fieldLocked(locks: readonly PdfFieldLock[], field: string): boolean {
	return locks.some(lock => {
		// A lock naming a parent field covers its descendants.
		const listed = lock.fields.some(name => field === name || field.startsWith(`${name}.`))

		return lock.action === "All" || (lock.action === "Include" ? listed : !listed)
	})
}

export function changeAllowed(change: PdfChange, certification: PdfCertificationLevel | null, locks: readonly PdfFieldLock[]): boolean {
	switch (change.kind) {
		case "dss":
			return true
		case "signature":
			return certification !== 1
		case "form":
			return certification !== 1 && (change.field === undefined || !fieldLocked(locks, change.field))
		case "annotation":
			return certification === null || certification === 3
		case "content":
			return false
	}
}

// DocMDP /P: 1, 2 or 3; absent means 2.
export function certificationLevel(p: number | null): PdfCertificationLevel | null {
	if (p === null) return 2
	if (p === 1 || p === 2 || p === 3) return p

	return null
}
