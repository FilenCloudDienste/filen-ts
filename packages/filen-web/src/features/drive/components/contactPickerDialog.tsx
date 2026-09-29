import { useState } from "react"
import { useTranslation } from "react-i18next"
import { type DriveItem } from "@/features/drive/lib/item"
import { shareItems } from "@/features/drive/lib/share/actions"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { useIsOnline } from "@/lib/useIsOnline"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { resolveSelectedContacts, togglePickerContact } from "@/features/contacts/lib/contactPicker.logic"
import { ContactPickerList } from "@/features/contacts/components/contactPickerList"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export interface ContactPickerDialogProps {
	items: DriveItem[]
	onClose: () => void
	// Post-success selection cleanup, overridable so a non-drive caller (features/photos) can prune ITS
	// OWN selection store instead of drive's — defaults to the drive listing's own useDriveStore call
	// below, unchanged for every existing caller.
	onShared?: (succeededUuids: string[]) => void
}

// Contact picker — mounted-when-active by the listing's dialog host (directoryListing.tsx's "share"
// case) for both the per-item menu and the bulk bar. Multi-selects from the established contact list
// (ContactPickerList) and shares every chosen item with every chosen contact via shareItems. No confirm
// step — picking contacts and pressing Share IS the confirmation (mobile parity).
export function ContactPickerDialog({ items, onClose, onShared }: ContactPickerDialogProps) {
	const { t } = useTranslation(["drive", "contacts", "common"])
	const isOnline = useIsOnline()
	const contactsQuery = useContactsQuery()
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
	const [pending, setPending] = useState(false)
	const [filter, setFilter] = useState("")

	const contacts = contactsQuery.data?.contacts ?? []

	const handleOpenChange = pendingGuardedOpenChange(pending, next => {
		if (!next) {
			onClose()
		}
	})

	function toggle(uuid: string): void {
		setSelected(prev => togglePickerContact(prev, uuid))
	}

	async function handleShare(): Promise<void> {
		const chosen = resolveSelectedContacts(contacts, selected)

		if (chosen.length === 0) {
			return
		}

		setPending(true)
		const outcome = await shareItems(items, chosen)
		setPending(false)
		toastBulkOutcome(outcome)

		// Close on any success (full or partial) — mirrors the rename/new-directory convention: stay open
		// only on TOTAL failure so the user can retry without re-opening the picker. A shared item stays
		// visible in its listing (unlike a moved/trashed one), but its uuid is pruned from the selection
		// all the same — matching every other bulk action's post-success cleanup and mobile's
		// clear-selection-on-share; a failed item stays selected for the retry.
		if (outcome.succeeded.length > 0) {
			onClose()
			const succeededUuids = outcome.succeeded.map(succeededItem => succeededItem.data.uuid)

			if (onShared) {
				onShared(succeededUuids)
			} else {
				useDriveStore.getState().removeFromSelection(succeededUuids)
			}
		}
	}

	// Re-checks connectivity at the confirm layer: the entry point that opened this picker was gated
	// when it was clicked, but the connection can drop while the picker is open.
	const canSubmit = selected.size > 0 && !pending && isOnline

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent
				closeButtonDisabled={pending}
				className="sm:max-w-lg"
			>
				<DialogHeader>
					<DialogTitle>{t("driveShareDialogTitle")}</DialogTitle>
					<DialogDescription>{t("driveShareDialogBody", { count: items.length })}</DialogDescription>
				</DialogHeader>
				<ContactPickerList
					contactsQuery={contactsQuery}
					filter={filter}
					onFilterChange={setFilter}
					selected={selected}
					onToggle={toggle}
					ariaLabel={t("contacts:contactsSectionContacts")}
					emptyTitle={t("contacts:contactsEmptyTitle")}
					emptyDescription={t("contacts:contactsEmptyBody")}
				/>
				<DialogFooter>
					<Button
						variant="outline"
						disabled={pending}
						onClick={onClose}
					>
						{t("common:cancel")}
					</Button>
					<Button
						disabled={!canSubmit}
						title={!isOnline ? t("common:offlineActionDisabled") : undefined}
						onClick={() => {
							void handleShare()
						}}
					>
						{pending && <Spinner data-icon="inline-start" />}
						{t("driveActionShare")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
