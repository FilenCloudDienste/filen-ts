import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { attachExistingDriveItem } from "@/features/chats/lib/attachments"
import { type DriveItem } from "@/features/drive/lib/item"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { driveItemName } from "@filen/shared"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { ItemIcon } from "@/features/drive/components/itemIcon"
import { PICKER_ROW_CLASS, PickerBreadcrumb, PickerListShell } from "@/features/drive/components/directoryPicker"
import { useDirectoryPicker } from "@/features/drive/hooks/useDirectoryPicker"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { LIST_DIALOG_CLASS } from "@/components/dialogs/listDialog"

export interface AttachDriveDialogProps {
	onClose: () => void
	// Fired once a click-to-attach resolves to a usable public-link url — the caller (composer.tsx)
	// inserts it and closes the dialog itself (this component never touches the composer's draft).
	onAttached: (url: string) => void
}

// Drive-file picker for the composer's attach flow, built on directoryPicker.tsx — there is exactly
// one directory-tree data source in this app and this is it. The SELECTION semantics differ from move on purpose: a directory row descends (browsing), a
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
			toast.error(errorLabel(outcome.dto))
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
				<PickerListShell
					listingQuery={listingQuery}
					isEmpty={rows.length === 0}
				>
					{rows.map(item => {
						const disabled = item.data.undecryptable || attachingUuid !== null
						const isAttaching = attachingUuid === item.data.uuid

						return (
							<li key={item.data.uuid}>
								<button
									type="button"
									disabled={disabled}
									onClick={() => {
										if (item.type === "directory") {
											descend(item.data.uuid)
											return
										}

										void handleAttach(item)
									}}
									className={PICKER_ROW_CLASS}
								>
									<ItemIcon
										item={item}
										className="size-4 shrink-0"
									/>
									<span className="min-w-0 flex-1 truncate">{driveItemName(item)}</span>
									{isAttaching ? <Spinner className="size-3.5 shrink-0" /> : null}
								</button>
							</li>
						)
					})}
				</PickerListShell>
			</DialogContent>
		</Dialog>
	)
}
