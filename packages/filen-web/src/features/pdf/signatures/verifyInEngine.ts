import type { PdfSignatureReport } from "@filen/office/core/pdfsign"
import type { PdfSignatureFieldHint } from "@filen/office/dom/pdf"
import type { AnyFile } from "@filen/sdk-rs"
import { openPdfEngine } from "@/features/pdf/session/engineWorker"
import type { PreviewAccessMode } from "@/features/preview/lib/accessMode"

// One signature check in a short-lived engine worker opened read-only on the file (ranged: only the signed byte
// ranges, the xref and the signature dictionaries are read). The worker is closed once the report is in, or as soon as
// the check is abandoned.
export async function verifyInEngine(
	file: AnyFile,
	access: PreviewAccessMode,
	fields: readonly PdfSignatureFieldHint[] | null,
	signal: AbortSignal
): Promise<PdfSignatureReport> {
	signal.throwIfAborted()

	const engine = await openPdfEngine({ file, access, role: "verify" })
	const close = (): void => {
		void engine.close()
	}

	if (signal.aborted) {
		close()
		signal.throwIfAborted()
	}

	signal.addEventListener("abort", close, { once: true })

	return engine.client.call("verifySignatures", { fields }).then(
		report => {
			signal.removeEventListener("abort", close)
			close()

			return report
		},
		(error: unknown) => {
			signal.removeEventListener("abort", close)
			close()

			throw error
		}
	)
}
