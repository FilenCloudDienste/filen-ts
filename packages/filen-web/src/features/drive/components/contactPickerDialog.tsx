import { useState } from "react"
import { useTranslation } from "react-i18next"
import { contactDisplayName, toggleInSet } from "@filen/shared"
import { type DriveItem } from "@/features/drive/lib/item"
import { shareItems } from "@/features/drive/lib/share/actions"
import { DRIVE_SHARE, driveActivity } from "@/features/drive/lib/activity"
import { runBulkActivity } from "@/lib/activity/activity"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { useIsOnline } from "@/lib/useIsOnline"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { resolveSelectedContacts } from "@/features/contacts/lib/contactPicker.logic"
import { ContactPickerList } from "@/features/contacts/components/contactPickerList"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { LIST_DIALOG_CLASS } from "@/components/dialogs/listDialog"

export interface ContactPickerDialogProps {
	items: DriveItem[]
	onClose: () => void
	// Post-success selection cleanup, overridable so a non-drive caller (features/photos) can prune ITS
	// OWN selection store instead of drive's (driveActivity's default prune).
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
		setSelected(prev => toggleInSet(prev, uuid))
	}

	async function handleShare(): Promise<void> {
		const chosen = resolveSelectedContacts(contacts, selected)
		const [onlyContact] = chosen

		if (onlyContact === undefined) {
			return
		}

		// A shared item stays visible in its listing (unlike a moved/trashed one), but its uuid is pruned
		// from the selection all the same — matching every other bulk action's post-success cleanup and
		// mobile's clear-selection-on-share; a failed item stays selected for the retry.
		const spec = driveActivity(
			items,
			DRIVE_SHARE,
			(targets, _onSettled, report) =>
				shareItems(targets, chosen, value => {
					report({ kind: "fraction", value })
				}),
			{
				values: {
					recipients: chosen.length === 1 ? contactDisplayName(onlyContact) : t("driveShareRecipients", { count: chosen.length })
				},
				...(onShared === undefined
					? {}
					: {
							prune: succeeded => {
								onShared(succeeded.map(item => item.data.uuid))
							}
						})
			}
		)

		// The hand-off of a bulk confirm (useDialogHost's runBulkDialogActivity), which a directory's share
		// joins however few items: re-encrypting its tree for each contact can run long.
		if (items.length > 1 || items.some(item => item.type === "directory")) {
			onClose()
			void runBulkActivity(spec)

			return
		}

		setPending(true)

		const outcome = await runBulkActivity({ ...spec, showRunning: false })

		setPending(false)

		// A failure keeps the picker open on the chosen contacts, to try again or change them.
		if (outcome.failed.length === 0) {
			onClose()
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
				className={LIST_DIALOG_CLASS}
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
