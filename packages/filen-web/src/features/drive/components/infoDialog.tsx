import { useState } from "react"
import { useTranslation } from "react-i18next"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { ItemDetails, type ItemDetailsDialog } from "@/features/drive/components/itemDetails"
import { LinkDialog } from "@/features/drive/components/linkDialog"
import { ContactPickerDialog } from "@/features/drive/components/contactPickerDialog"
import { VersionsDialog } from "@/features/drive/components/versionsDialog"
import { CannotDecryptState } from "@/components/cannotDecryptState"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

export interface InfoDialogProps {
	item: DriveItem
	variant: DriveVariant
	onClose: () => void
}

// The item details (itemDetails.tsx) as a dialog, for the surfaces without the listing's details panel: the preview's
// menu and photos. The same sections as the panel; the dialogs they open (link, share, versions) nest in this one.
// The Location row navigates to the item's parent directory and closes the dialog.
export function InfoDialog({ item, variant, onClose }: InfoDialogProps) {
	// ["drive", "common"] so the undecryptable branch can reach the shared cannot-decrypt label.
	const { t } = useTranslation(["drive", "common"])
	const [nested, setNested] = useState<ItemDetailsDialog | null>(null)

	function closeNested(): void {
		setNested(null)
	}

	return (
		<Dialog
			open
			onOpenChange={next => {
				if (!next) {
					onClose()
				}
			}}
		>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
				{/* The DialogTitle is kept for the dialog's accessible name; the explainer owns its own heading. */}
				{item.data.undecryptable ? (
					<>
						<DialogTitle className="sr-only">{t("common:cannotDecryptTitle")}</DialogTitle>
						<CannotDecryptState />
					</>
				) : (
					<ItemDetails
						item={item}
						variant={variant}
						remoteReady
						large
						renderName={(name, className) => <DialogTitle className={className}>{name}</DialogTitle>}
						onOpenDialog={setNested}
						onNavigate={onClose}
					/>
				)}
			</DialogContent>
			{nested === "link" ? (
				<LinkDialog
					item={item}
					onClose={closeNested}
				/>
			) : nested === "share" ? (
				<ContactPickerDialog
					items={[item]}
					onClose={closeNested}
				/>
			) : nested === "versions" && item.type === "file" ? (
				<VersionsDialog
					file={item}
					onClose={closeNested}
				/>
			) : null}
		</Dialog>
	)
}
