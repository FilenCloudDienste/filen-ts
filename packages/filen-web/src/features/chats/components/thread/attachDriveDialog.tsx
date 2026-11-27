import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { attachExistingDriveItem } from "@/features/chats/lib/attachments"
import { type DriveItem } from "@/features/drive/lib/item"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { PickerBreadcrumb } from "@/features/drive/components/directoryPicker"
import { DriveFilePickerList } from "@/features/drive/components/driveFilePickerDialog"
import { useDirectoryPicker } from "@/features/drive/hooks/useDirectoryPicker"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { LIST_DIALOG_CLASS } from "@/components/dialogs/listDialog"

export interface AttachDriveDialogProps {
	onClose: () => void
	// Fired once a click-to-attach resolves to a usable public-link url — the caller (composer.tsx)
	// inserts it and closes the dialog itself (this component never touches the composer's draft).
	onAttached: (url: string) => void
}

// Drive-file picker for the composer's attach flow, built on directoryPicker.tsx and the shared file list
// (driveFilePickerDialog.tsx) — there is exactly one directory-tree data source in this app and this is it. The SELECTION semantics differ from move on purpose: a directory row descends (browsing), a
// FILE row is clickable and immediately attaches (no separate confirm step — a picker with one purpose
// per row needs no "select then confirm" ceremony move's multi-item flow does). An item that already
// carries a public link reuses it (attachExistingDriveItem's own get-then-create) rather than erroring.
export function AttachDriveDialog({ onClose, onAttached }: AttachDriveDialogProps) {
	const { t } = useTranslation("chats")
	const { pathStack, listingQuery, items: rows, namesQuery, descend, goRoot, goTo } = useDirectoryPicker()
	const [attachingUuid, setAttachingUuid] = useState<string | null>(null)

	const handleOpenChange = pendingGuardedOpenChange(attachingUuid !== null, next => {
		if (!next) {
			onClose()
		}
	})

	async function handleAttach(item: DriveItem): Promise<void> {
		if (item.data.undecryptable) {
			return
		}

		setAttachingUuid(item.data.uuid)
		const outcome = await attachExistingDriveItem(item)
		setAttachingUuid(null)

		if (outcome.status === "error") {
			toast.error(t("chatComposerAttachFileFailed", { name: item.data.decryptedMeta?.name ?? "" }), {
				description: errorLabel(outcome.dto)
			})
			return
		}

		onAttached(outcome.url)
	}

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent
				closeButtonDisabled={attachingUuid !== null}
				className={LIST_DIALOG_CLASS}
			>
				<DialogHeader>
					<DialogTitle>{t("chatAttachDriveDialogTitle")}</DialogTitle>
				</DialogHeader>
				<PickerBreadcrumb
					pathStack={pathStack}
					names={namesQuery.data}
					onRoot={goRoot}
					onJump={goTo}
				/>
				<p className="text-xs text-muted-foreground">{t("chatAttachDriveDialogHint")}</p>
				<DriveFilePickerList
					listingQuery={listingQuery}
					rows={rows}
					pending={attachingUuid}
					onDescend={descend}
					onPick={item => {
						void handleAttach(item)
					}}
				/>
			</DialogContent>
		</Dialog>
	)
}
