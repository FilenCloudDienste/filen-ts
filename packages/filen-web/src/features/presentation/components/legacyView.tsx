import { useTranslation } from "react-i18next"
import { FileClockIcon } from "lucide-react"
import type { Format } from "@filen/office/core/presentation"

// The read-only face of a PowerPoint 97–2003 deck (.ppt, .pps, .pot): the presentation viewer shows it as it shows any
// deck (the worker converted it to a pptx it reads), with this bar under the command bar saying it is the legacy
// binary format and is viewed only. No edit control is offered for it (the viewer opens it view-only, and the format
// is never editable: isEditablePresentationExtension).

export function LegacyPresentationBar({ format }: { format: Format | undefined }) {
	const { t } = useTranslation("preview")

	if (format !== "ppt") return null

	return (
		<div
			role="status"
			aria-label={t("previewPptxLegacyLabel")}
			data-legacy-presentation
			className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
		>
			<FileClockIcon
				aria-hidden
				className="mt-px size-3.5 shrink-0"
			/>
			<p className="min-w-0 flex-1 break-words">{t("previewPptxLegacyViewOnly")}</p>
		</div>
	)
}
