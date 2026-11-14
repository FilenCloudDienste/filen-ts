import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { PDF_FULL_READ_WARN_BYTES } from "@/features/preview/lib/pdfLimits"

// What reads every page of a ranged document: searching it, printing all of it.
export type PdfFullRead = "find" | "print"

export interface PdfFullReadGuard {
	// Whether `kind` must be confirmed first: the file is larger than PDF_FULL_READ_WARN_BYTES and the reader has not
	// confirmed it for this document yet. A caller that gets false goes ahead synchronously.
	needs(kind: PdfFullRead): boolean
	// Asks (when needed) and resolves with the answer; true at once when nothing needs asking.
	confirm(kind: PdfFullRead): Promise<boolean>
	// Keeps the read document's memory while a full read is in use (a print job): the viewer reopens the document to
	// drop it only once nothing holds it. Returns the release.
	hold(): () => void
	readonly holds: number
	// Bumped by every confirmed full read, so the viewer can tell one it asked for from pdf.js reading everything on its
	// own (a damaged file).
	readonly confirmations: number
	readonly dialog: ReactNode
}

interface Pending {
	readonly kind: PdfFullRead
	readonly resolve: (confirmed: boolean) => void
}

// The confirmation before reading the whole of a large PDF the viewer otherwise reads page by page.
export function usePdfFullReadGuard(size: number): PdfFullReadGuard {
	const { t } = useTranslation("preview")
	const [confirmed, setConfirmed] = useState<readonly PdfFullRead[]>([])
	const [pending, setPending] = useState<Pending | null>(null)
	const [holds, setHolds] = useState(0)
	const [confirmations, setConfirmations] = useState(0)
	const needs = (kind: PdfFullRead): boolean => size > PDF_FULL_READ_WARN_BYTES && !confirmed.includes(kind)

	const answer = (value: boolean): void => {
		if (pending === null) return

		setPending(null)

		if (value) {
			setConfirmed(previous => (previous.includes(pending.kind) ? previous : [...previous, pending.kind]))
			setConfirmations(previous => previous + 1)
		}

		pending.resolve(value)
	}

	return {
		needs,
		confirm: kind => {
			if (!needs(kind)) return Promise.resolve(true)

			// A second ask while one is open is answered no: one dialog at a time.
			if (pending !== null) return Promise.resolve(false)

			return new Promise<boolean>(resolve => {
				setPending({ kind, resolve })
			})
		},
		hold: () => {
			let held = true

			setHolds(previous => previous + 1)

			return () => {
				if (!held) return

				held = false
				setHolds(previous => previous - 1)
			}
		},
		holds,
		confirmations,
		dialog: (
			<ConfirmDialog
				open={pending !== null}
				pending={false}
				title={t("previewPdfFullReadTitle")}
				body={
					pending?.kind === "print"
						? t("previewPdfFullReadPrint", { size: formatBytes(size) })
						: t("previewPdfFullReadFind", { size: formatBytes(size) })
				}
				confirmLabel={t("previewPdfFullReadContinue")}
				cancelLabel={t("previewPdfFullReadCancel")}
				onOpenChange={open => {
					if (!open) answer(false)
				}}
				onConfirm={() => {
					answer(true)
				}}
			/>
		)
	}
}
