import { useTranslation } from "react-i18next"
import { PaintbrushVerticalIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { keepFocus } from "@/features/office/lib/officeControls"
import { painterAction, type DocxPainterState } from "@/features/preview/components/docxEditor.logic"

// The Clipboard group's Format Painter, shared by the document and presentation editors: a click picks up the
// selection's formatting for the next one, a double click keeps it on, a click while it is on turns it off.
export function FormatPainterButton({
	state,
	disabled,
	onCopy,
	onCancel
}: {
	state: DocxPainterState
	disabled: boolean
	onCopy: (sticky: boolean) => void
	onCancel: () => void
}) {
	const { t } = useTranslation("preview")

	return (
		<TooltipIconButton
			label={state === "sticky" ? t("previewOfficeFormatPainterSticky") : t("previewOfficeFormatPainter")}
			pressed={state !== "off"}
			disabled={disabled}
			className={cn(state !== "off" && "bg-accent text-foreground")}
			onMouseDown={keepFocus}
			onClick={event => {
				const action = painterAction(event.detail, state)

				if (action === "cancel") onCancel()
				else onCopy(action === "sticky")
			}}
		>
			<PaintbrushVerticalIcon />
		</TooltipIconButton>
	)
}
