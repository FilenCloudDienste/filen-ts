import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Trash2Icon } from "lucide-react"
import type { DriveItem } from "@/features/drive/lib/item"
import { deleteEarlierVersions } from "@/features/pdf/save/earlierVersions"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useIsOnline } from "@/lib/useIsOnline"

export interface EarlierVersionsWarningProps {
	// The version the save wrote: every other version of the file is an earlier one.
	item: DriveItem
	open: boolean
	onOpenChange: (open: boolean) => void
}

// After an in-place save whose changes removed content (redaction, deleted pages, ...): the earlier versions still
// hold it. Offers deleting them, confirmed first like the versions panel's Delete all (permanent, irreversible).
export function EarlierVersionsWarning({ item, open, onOpenChange }: EarlierVersionsWarningProps) {
	const { t } = useTranslation(["preview", "common"])
	const isOnline = useIsOnline()
	const [confirming, setConfirming] = useState(false)
	const [pending, setPending] = useState(false)

	const handleOpenChange = pendingGuardedOpenChange(pending, next => {
		if (!next) {
			setConfirming(false)
		}

		onOpenChange(next)
	})

	async function handleConfirmed(): Promise<void> {
		if (item.type !== "file") {
			return
		}

		setPending(true)
		const done = await deleteEarlierVersions(item)
		setPending(false)
		setConfirming(false)

		if (done) {
			onOpenChange(false)
		}
	}

	return (
		<AlertDialog
			open={open}
			onOpenChange={handleOpenChange}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle className="text-base font-normal">{t("previewPdfEarlierVersions")}</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<Button
						variant="outline"
						autoFocus
						disabled={pending}
						onClick={() => {
							onOpenChange(false)
						}}
					>
						{t("common:close")}
					</Button>
					<Button
						variant="destructive"
						disabled={pending || !isOnline || item.type !== "file"}
						title={isOnline ? undefined : t("common:offlineActionDisabled")}
						onClick={() => {
							setConfirming(true)
						}}
					>
						{pending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
						{t("previewPdfDeleteEarlierVersions")}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
			{/* Nested, so the stacked focus trap and backdrop apply. */}
			<ConfirmDialog
				open={confirming}
				pending={pending}
				title={t("previewPdfDeleteEarlierVersionsTitle")}
				body={t("previewPdfDeleteEarlierVersionsBody")}
				confirmLabel={t("previewPdfDeleteEarlierVersions")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={next => {
					if (!next) {
						setConfirming(false)
					}
				}}
				onConfirm={() => {
					void handleConfirmed()
				}}
			/>
		</AlertDialog>
	)
}
