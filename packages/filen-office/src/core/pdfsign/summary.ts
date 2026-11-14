import type { PdfSignatureInfo, PdfSignatureReport } from "./types"

// The one line a document's signatures are summarised in: the most serious state among them, and the signature it
// comes from (the latest such one).

export type PdfSignatureSummaryState = "invalid" | "unverifiable" | "changedNotAllowed" | "changedAllowed" | "unchanged"

export interface PdfSignatureSummary {
	readonly state: PdfSignatureSummaryState
	readonly signature: PdfSignatureInfo
}

const SEVERITY: Readonly<Record<PdfSignatureSummaryState, number>> = {
	invalid: 4,
	unverifiable: 3,
	changedNotAllowed: 2,
	changedAllowed: 1,
	unchanged: 0
}

export function summaryState(signature: PdfSignatureInfo): PdfSignatureSummaryState {
	switch (signature.state) {
		case "invalid":
			return "invalid"
		case "unverifiable":
			return "unverifiable"
		case "changed":
			return signature.changes?.allowed === true ? "changedAllowed" : "changedNotAllowed"
		case "unchanged":
			return "unchanged"
	}
}

export function signatureSummary(report: PdfSignatureReport): PdfSignatureSummary | null {
	let best: PdfSignatureSummary | null = null

	for (const signature of report.signatures) {
		const state = summaryState(signature)

		if (best === null || SEVERITY[state] >= SEVERITY[best.state]) best = { state, signature }
	}

	return best
}
