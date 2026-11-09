import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

// Excel's question when cells dragged by the selection's border are dropped over cells holding data: "There's already
// data here. Do you want to replace it?", OK or Cancel. `ask` is the grid's onConfirmReplace; `dialog` is rendered
// beside the grid.
export function useMoveReplace(): { ask: (replace: () => void) => void; dialog: ReactNode } {
	const { t } = useTranslation(["preview", "common"])
	const [pending, setPending] = useState<{ readonly replace: () => void } | null>(null)

	function ask(replace: () => void): void {
		setPending({ replace })
	}

	const dialog = (
		<ConfirmDialog
			open={pending !== null}
			pending={false}
			title={t("previewSheetMoveReplaceTitle")}
			body={t("previewSheetMoveReplaceBody")}
			confirmLabel={t("previewSheetMoveReplaceConfirm")}
			cancelLabel={t("common:cancel")}
			onOpenChange={open => {
				if (!open) {
					setPending(null)
				}
			}}
			onConfirm={() => {
				pending?.replace()
				setPending(null)
			}}
		/>
	)

	return { ask, dialog }
}
