import type { RefObject } from "react"
import { useTranslation } from "react-i18next"
import type { SheetGridHandle } from "@filen/office/react/sheet"
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

// Excel's circular reference warning, shown once per circle an edit makes while the workbook does not calculate
// iteratively ("circularReferences" with `introduced`); OK closes it and typing goes on in the grid.
export function CircularWarning({
	open,
	onClose,
	gridRef
}: {
	open: boolean
	onClose: () => void
	gridRef: RefObject<SheetGridHandle | null>
}) {
	const { t } = useTranslation("preview")

	return (
		<AlertDialog
			open={open}
			onOpenChange={next => {
				if (!next) onClose()
			}}
		>
			<AlertDialogContent
				finalFocus={() => {
					gridRef.current?.focus()

					return false
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>{t("previewSheetCircularTitle")}</AlertDialogTitle>
					<AlertDialogDescription className="whitespace-pre-wrap">{t("previewSheetCircularBody")}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<Button
						type="button"
						autoFocus
						onClick={onClose}
					>
						{t("previewSheetCircularOk")}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
