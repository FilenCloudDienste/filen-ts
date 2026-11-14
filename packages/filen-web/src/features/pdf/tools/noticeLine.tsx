import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { InfoIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

// A tool's one-line notice under the ribbon (PdfToolContext.notify): what it said, and Dismiss.
export function PdfNoticeLine({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
	const { t } = useTranslation("preview")

	return (
		<div
			role="status"
			className="flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"
		>
			<InfoIcon
				aria-hidden="true"
				className="size-3.5 shrink-0"
			/>
			<p className="min-w-0 flex-1">{children}</p>
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
