import { useEffect, useState } from "react"
import { loadPdfSignatureFields, type PdfSignatureSource } from "@filen/office/dom/pdf"
import type { PdfSignatureReport } from "@filen/office/core/pdfsign"
import type { PdfSignatureVerify } from "@/features/pdf/signatures/useSignatureVerifier"
import { log } from "@/lib/log"

export type PdfSignatureCheck =
	| { readonly status: "none" }
	| { readonly status: "checking" }
	| { readonly status: "ready"; readonly report: PdfSignatureReport }
	| { readonly status: "failed" }

interface Checked {
	readonly document: PdfSignatureSource
	readonly attempt: number
	readonly check: PdfSignatureCheck
}

// The signatures of a document, checked once per document (and again on retry). pdf.js says whether there are any
// from the form alone; only then is the verifier asked, so an unsigned document never starts the engine.
export function usePdfSignatureReport(
	document: PdfSignatureSource,
	verify: PdfSignatureVerify | null
): { check: PdfSignatureCheck; retry: () => void } {
	const [attempt, setAttempt] = useState(0)
	const [checked, setChecked] = useState<Checked | null>(null)

	useEffect(() => {
		if (verify === null) {
			return undefined
		}

		const controller = new AbortController()
		const settle = (check: PdfSignatureCheck): void => {
			if (!controller.signal.aborted) {
				setChecked({ document, attempt, check })
			}
		}

		void loadPdfSignatureFields(document).then(fields => {
			if (fields !== null && fields.length === 0) {
				settle({ status: "none" })

				return
			}

			if (controller.signal.aborted) {
				return
			}

			settle({ status: "checking" })
			verify(fields, controller.signal).then(
				report => {
					settle(report.signatures.length === 0 ? { status: "none" } : { status: "ready", report })
				},
				(error: unknown) => {
					if (!controller.signal.aborted) {
						log.warn("preview", "pdf signature check failed", { error })
					}

					settle({ status: "failed" })
				}
			)
		})

		return () => {
			controller.abort()
		}
	}, [document, verify, attempt])

	const current = checked !== null && checked.document === document && checked.attempt === attempt ? checked.check : null

	return {
		// Nothing shows until pdf.js has found signatures: most documents have none.
		check: verify === null ? { status: "none" } : (current ?? { status: "none" }),
		retry: () => {
			setAttempt(value => value + 1)
		}
	}
}
