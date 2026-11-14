import { useTranslation } from "react-i18next"
import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

export type PdfRemoteChangeAnswer = "copy" | "version" | "cancel"

export interface PdfRemoteChangeDialogProps {
	open: boolean
	onAnswer: (answer: PdfRemoteChangeAnswer) => void
}

// Asked before an in-place save when a newer version of the file was saved elsewhere (checkRemoteHead): save the
// edits as a copy beside it (the default, as it loses nothing), as a new version anyway, or not at all (what Escape
// means).
export function PdfRemoteChangeDialog({ open, onAnswer }: PdfRemoteChangeDialogProps) {
	const { t } = useTranslation("preview")

	return (
		<AlertDialog
			open={open}
			onOpenChange={next => {
				if (!next) {
					onAnswer("cancel")
				}
			}}
		>
			<AlertDialogContent className="data-[size=default]:sm:max-w-xl">
				<AlertDialogHeader>
					<AlertDialogTitle>{t("previewPdfRemoteChanged")}</AlertDialogTitle>
				</AlertDialogHeader>
				{/* Wraps rather than overflowing the card when the labels run long (translations). */}
				<AlertDialogFooter className="sm:flex-wrap sm:items-center">
					<Button
						variant="ghost"
						className="sm:mr-auto"
						onClick={() => {
							onAnswer("cancel")
						}}
					>
						{t("previewPdfRemoteCancel")}
					</Button>
					<Button
						variant="outline"
						onClick={() => {
							onAnswer("version")
						}}
					>
						{t("previewPdfRemoteSaveAnyway")}
					</Button>
					<Button
						autoFocus
						onClick={() => {
							onAnswer("copy")
						}}
					>
						{t("previewPdfSaveAsCopy")}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
