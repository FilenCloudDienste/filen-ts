import type { PdfSignatureReport } from "@filen/office/core/pdfsign"
import type { PdfSignatureFieldHint } from "@filen/office/dom/pdf"

// Verifies the open document's signatures in the PDF engine worker (MuPDF + WebCrypto). `fields` are the signatures
// pdf.js found, which the engine cross-checks against its own reading; null when pdf.js could not tell.
export type PdfSignatureVerify = (fields: readonly PdfSignatureFieldHint[] | null, signal: AbortSignal) => Promise<PdfSignatureReport>

// The verifier of the document shown, or null while no engine worker can be started for it (then no signature status
// is shown).
export function useSignatureVerifier(): PdfSignatureVerify | null {
	return null
}
