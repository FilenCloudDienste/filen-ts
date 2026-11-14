import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import { loadPdfInfo, type PdfDocumentInfo } from "@filen/office/dom/pdf"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { OfficeCommandBar } from "@/features/office/components/ribbon/officeRibbon"
import { usePdfCommandParts, type PdfCommandBarProps } from "@/features/preview/components/pdfCommandParts"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { formatDateTime } from "@/lib/formatDate"

export type { PdfCommandBarProps } from "@/features/preview/components/pdfCommandParts"

// The PDF viewer's bar where no ribbon is shown: one row of its commands (usePdfCommandParts).
export function PdfCommandBar(props: PdfCommandBarProps) {
	const { t } = useTranslation("preview")
	const parts = usePdfCommandParts(props)

	return (
		<OfficeCommandBar
			label={t("previewOfficeRibbonCommands")}
			file={parts.file}
			groups={parts.groups}
			replacement={parts.replacement}
			status={parts.status}
		/>
	)
}

function PropertyRow({ label, value }: { label: string; value: string | null }) {
	const { t } = useTranslation("preview")

	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-words">{value ?? t("previewCommandBarPropertyNone")}</dd>
		</>
	)
}

// What the document says about itself (its Info dictionary, read once per document) and what the viewer knows.
export function PdfPropertiesDialog({
	open,
	onOpenChange,
	document,
	size
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	document: PdfDomDocument
	// The file's bytes.
	size: number
}) {
	const { t } = useTranslation("preview")
	const [info, setInfo] = useState<{ document: PdfDomDocument; info: PdfDocumentInfo } | null>(null)
	const shown = info?.document === document ? info.info : null

	useEffect(() => {
		if (!open) {
			return undefined
		}

		let live = true

		void loadPdfInfo(document).then(read => {
			if (live) {
				setInfo({ document, info: read })
			}
		})

		return () => {
			live = false
		}
	}, [open, document])

	const date = (value: Date | null | undefined): string | null =>
		value === null || value === undefined ? null : formatDateTime(value.getTime())

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent data-preview-surface>
				<DialogHeader>
					<DialogTitle>{t("previewCommandBarProperties")}</DialogTitle>
				</DialogHeader>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
					<PropertyRow
						label={t("previewCommandBarPropertyTitle")}
						value={shown?.title ?? null}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyAuthor")}
						value={shown?.author ?? null}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertySubject")}
						value={shown?.subject ?? null}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyKeywords")}
						value={shown?.keywords ?? null}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyCreator")}
						value={shown?.creator ?? null}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyProducer")}
						value={shown?.producer ?? null}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyCreated")}
						value={date(shown?.created)}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyModified")}
						value={date(shown?.modified)}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyPages")}
						value={String(document.numPages)}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertySize")}
						value={formatBytes(size)}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyVersion")}
						value={shown?.version ?? null}
					/>
				</dl>
			</DialogContent>
		</Dialog>
	)
}
