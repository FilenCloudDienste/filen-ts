import type { PdfDocument } from "./types"

// The signatures pdf.js sees (getSignatures reads the AcroForm alone, no page): whether a document is signed at all,
// and the second parser's view the verifier cross-checks MuPDF's against.

export interface PdfSignatureFieldHint {
	// The field's own name (its /T), as pdf.js reports it.
	readonly name: string
	readonly byteRange: readonly [number, number, number, number]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function byteRangeOf(value: unknown): [number, number, number, number] | null {
	if (!Array.isArray(value) || value.length !== 4) return null

	const numbers = value.filter((item): item is number => typeof item === "number" && Number.isSafeInteger(item))

	if (numbers.length !== 4) return null

	const [a = 0, b = 0, c = 0, d = 0] = numbers

	return [a, b, c, d]
}

// pdf.js's signature metadata as hints; null when its shape is not the expected one (then nothing is trusted).
export function pdfSignatureFields(signatures: unknown): PdfSignatureFieldHint[] | null {
	if (signatures === null || signatures === undefined) return []
	if (!Array.isArray(signatures)) return null

	const hints: PdfSignatureFieldHint[] = []

	for (const signature of signatures) {
		if (!isRecord(signature)) return null

		const name = signature["fieldName"]
		const byteRange = byteRangeOf(signature["byteRange"])

		if (typeof name !== "string" || byteRange === null) return null

		hints.push({ name, byteRange })
	}

	return hints
}

// What the signatures are read from: a pdf.js document, or anything else answering as it does.
export type PdfSignatureSource = Pick<PdfDocument, "getSignatures">

const loads = new WeakMap<PdfSignatureSource, Promise<PdfSignatureFieldHint[] | null>>()

// Read once per document. A pdf.js without getSignatures reports none; a failed read is null (cannot tell).
export function loadPdfSignatureFields(document: PdfSignatureSource): Promise<PdfSignatureFieldHint[] | null> {
	let loading = loads.get(document)

	if (loading === undefined) {
		loading = (document.getSignatures?.() ?? Promise.resolve(null)).then(pdfSignatureFields, () => null)
		loads.set(document, loading)
	}

	return loading
}
