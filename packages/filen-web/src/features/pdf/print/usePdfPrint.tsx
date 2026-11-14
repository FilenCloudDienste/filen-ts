import { useEffect, useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { PdfPrintDialog, type PdfPrintFullRead } from "@/features/pdf/print/pdfPrintDialog"
import { pdfPrintPermissions, type PdfPrintPermissions } from "@/features/pdf/print/pdfPrint.logic"
import { usePreviewDownloadable } from "@/features/preview/lib/accessMode"
import { pdfMemoryConstrained } from "@/features/preview/lib/pdfLimits"
import { i18n } from "@/lib/i18n"
import { IN_EDITORS_AND_FIELDS, useAction } from "@/lib/keymap/useAction"
import { log } from "@/lib/log"

export interface PdfPrint {
	// Opens the print dialog (the File menu's Print…); undefined where printing is not offered.
	readonly open: (() => void) | undefined
	// The print dialog while open, to mount beside the viewer.
	readonly dialog: ReactNode
}

export interface PdfPrintInput {
	readonly document: PdfDomDocument
	// The page in view, 1-based.
	readonly current: number
	// The file's bytes.
	readonly size: number
	// Asked before every page of a large file is read (false cancels the print), and held while it prints.
	readonly fullRead?: PdfPrintFullRead | undefined
	// Starts fetching the editor (printing a changed document renders through it): on Print… and Mod+P.
	readonly prefetch?: (() => void) | undefined
}

// Printing a PDF from the viewer: the File menu's Print… and office.print (Mod+P) open the print dialog. A print is a
// copy of the file like a download, so it is offered only where the file may be downloaded, and only where the
// document's author allows printing; the key is taken anyway, so the browser's own print (the app's chrome) never runs
// from it, with a notice saying why nothing prints.
export function usePdfPrint({ document, current, size, fullRead, prefetch }: PdfPrintInput): PdfPrint {
	const downloadable = usePreviewDownloadable()
	const [opened, setOpened] = useState(0)
	const [permissions, setPermissions] = useState<{ readonly document: PdfDomDocument; readonly value: PdfPrintPermissions } | null>(null)
	const allowed = permissions?.document === document ? permissions.value : null

	// One worker round trip per document.
	useEffect(() => {
		let live = true
		const read = document.getPermissions?.() ?? Promise.resolve(null)

		void read.then(
			flags => {
				if (live) {
					setPermissions({ document, value: pdfPrintPermissions(flags) })
				}
			},
			(error: unknown) => {
				log.warn("preview", "pdf permissions failed", error)

				if (live) {
					setPermissions({ document, value: pdfPrintPermissions(null) })
				}
			}
		)

		return () => {
			live = false
		}
	}, [document])

	const open =
		!downloadable || !(allowed?.print ?? false)
			? undefined
			: () => {
					prefetch?.()
					setOpened(opened + 1)
				}

	useAction(
		"office.print",
		event => {
			event.preventDefault()

			if (event.repeat) {
				return
			}

			prefetch?.()

			if (open !== undefined) {
				open()
			} else if (!downloadable) {
				toast.info(i18n.t("preview:previewPdfPrintNotAllowed"))
			} else if (allowed !== null) {
				toast.info(i18n.t("preview:previewPdfPrintRestricted"))
			}
		},
		IN_EDITORS_AND_FIELDS,
		[open, downloadable, allowed, prefetch]
	)

	return {
		open,
		dialog:
			opened === 0 || allowed === null ? null : (
				<PdfPrintDialog
					key={opened}
					document={document}
					current={current}
					size={size}
					permissions={allowed}
					constrained={pdfMemoryConstrained()}
					fullRead={fullRead}
					onClose={() => {
						setOpened(0)
					}}
				/>
			)
	}
}
