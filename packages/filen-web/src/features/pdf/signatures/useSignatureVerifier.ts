import type { PdfSignatureReport } from "@filen/office/core/pdfsign"
import type { PdfSignatureFieldHint } from "@filen/office/dom/pdf"
import type { DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { usePreviewAccessMode, usePreviewByteSource } from "@/features/preview/lib/accessMode"
import { verifyInEngine } from "@/features/pdf/signatures/verifyInEngine"

// Verifies the open document's signatures in the PDF engine worker (MuPDF + WebCrypto). `fields` are the signatures
// pdf.js found, which the engine cross-checks against its own reading; null when pdf.js could not tell.
export type PdfSignatureVerify = (fields: readonly PdfSignatureFieldHint[] | null, signal: AbortSignal) => Promise<PdfSignatureReport>

// The verifier of the file shown, or null where no engine can read it (an archive's entry: its bytes are not a drive
// file), and then no signature status is shown.
export function useSignatureVerifier(item: DriveItem): PdfSignatureVerify | null {
	const access = usePreviewAccessMode()
	const entry = usePreviewByteSource()

	if (entry !== null) {
		return null
	}

	return (fields, signal) => verifyInEngine(narrowToAnyFile(item), access, fields, signal)
}
