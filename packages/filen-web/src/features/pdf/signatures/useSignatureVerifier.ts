import type { PdfSignatureReport } from "@filen/office/core/pdfsign"
import type { PdfSignatureFieldHint } from "@filen/office/dom/pdf"
import type { DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { usePreviewAccessMode, usePreviewByteSource } from "@/features/preview/lib/accessMode"
import { verifyInEngine } from "@/features/pdf/signatures/verifyInEngine"
import type { PdfEditPhase } from "@/features/pdf/session/swap"

// Verifies the open document's signatures in the PDF engine worker (MuPDF + WebCrypto). `fields` are the signatures
// pdf.js found, which the engine cross-checks against its own reading; null when pdf.js could not tell.
export type PdfSignatureVerify = (fields: readonly PdfSignatureFieldHint[] | null, signal: AbortSignal) => Promise<PdfSignatureReport>

// What the verifier asks of the editor: its engine while it has the document, and the password the viewer accepted.
export interface PdfSignatureEditor {
	getSnapshot(): PdfEditPhase
	password(): string | undefined
}

// The verifier of the file shown, or null where no engine can read it (an archive's entry: its bytes are not a drive
// file), and then no signature status is shown. While the editor has the document its own engine checks the file as
// it now is (the last save it holds; a signing there changes the signatures); before, a short-lived engine reads the
// file, unlocked with the password the viewer accepted. A new version of the file (a save) is checked again.
export function useSignatureVerifier(item: DriveItem, editor: PdfSignatureEditor): PdfSignatureVerify | null {
	const access = usePreviewAccessMode()
	const entry = usePreviewByteSource()

	if (entry !== null) {
		return null
	}

	return (fields, signal) => {
		const phase = editor.getSnapshot()

		if (phase.kind === "editing") {
			signal.throwIfAborted()

			return phase.engine.client.call("verifySignatures", { fields })
		}

		return verifyInEngine(narrowToAnyFile(item), access, fields, signal, editor.password())
	}
}
