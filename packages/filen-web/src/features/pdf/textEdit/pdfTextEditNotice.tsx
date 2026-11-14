import { useTranslation } from "react-i18next"
import { TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

// The one-line notice under the ribbon when clicked text can't be edited ("cantEdit": shapes, a Type 3 font, vertical
// or curved text), there is no text where Edit text was used ("noText"), or an edit was refused because it would have
// removed nearby text ("unsafe"). Where it sits is
// the shell's; this is the line itself.

export type PdfTextEditNoticeKind = "cantEdit" | "unsafe" | "noText"

const NOTICE_KEYS = {
	cantEdit: "previewPdfTextEditNotPossible",
	unsafe: "previewPdfTextEditUnsafe",
	noText: "previewPdfTextEditNoText"
} as const satisfies Record<PdfTextEditNoticeKind, string>

export interface PdfTextEditNoticeProps {
	kind: PdfTextEditNoticeKind
	onDismiss: () => void
}

const LINE = "flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"

export function PdfTextEditNotice({ kind, onDismiss }: PdfTextEditNoticeProps) {
	const { t } = useTranslation("preview")

	return (
		<div
			role="status"
			data-kind={kind}
			className={LINE}
		>
			<TriangleAlertIcon
				aria-hidden="true"
				className="size-3.5 shrink-0"
			/>
			<p className="min-w-0 flex-1">{t(NOTICE_KEYS[kind])}</p>
			<Button
				variant="outline"
				size="xs"
				onClick={onDismiss}
			>
				{t("previewPdfTextEditDismiss")}
			</Button>
		</div>
	)
}
