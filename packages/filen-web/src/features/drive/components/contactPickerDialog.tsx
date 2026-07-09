import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, UsersIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import { type DriveItem } from "@/features/drive/lib/item"
import { shareItems } from "@/features/drive/lib/share/actions"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { resolveSelectedContacts, togglePickerContact } from "@/features/drive/components/contactPickerDialog.logic"
import { ContactRow } from "@/features/contacts/components/contactRow"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export interface ContactPickerDialogProps {
	items: DriveItem[]
	onClose: () => void
}

const SKELETON_ROW_COUNT = 5

// Contact picker — mounted-when-active by the listing's dialog host (directory-listing.tsx's "share"
// case) for both the per-item menu and the bulk bar. Multi-selects from the established contact list
// (reusing ContactRow's avatar/name/presence visuals + its selectable-option treatment) and shares
// every chosen item with every chosen contact via shareItems. No confirm step — picking contacts and
// pressing Share IS the confirmation (mobile parity). Design polish is deferred to a later pass; this
// is a clean functional picker built from existing primitives.
export function ContactPickerDialog({ items, onClose }: ContactPickerDialogProps) {
	const { t } = useTranslation(["drive", "contacts", "common"])
	const contactsQuery = useContactsQuery()
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
	const [pending, setPending] = useState(false)

	const contacts = contactsQuery.data?.contacts ?? []

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pending)) {
			// Also stops Base UI's own store from flipping (it closes itself after this callback unless
			// the event is canceled) — see dismissal.logic.ts.
			details.cancel()
			return
		}

		if (!next) {
			onClose()
		}
	}

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
			useDriveStore.getState().removeFromSelection(outcome.succeeded.map(succeededItem => succeededItem.data.uuid))
		}
	}

	function renderBody(): ReactNode {
		if (contactsQuery.status === "pending") {
			return (
				<div className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
					{Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
						<Skeleton
							key={index}
							className="h-14 w-full rounded-xl"
						/>
					))}
				</div>
			)
		}

		if (contactsQuery.status === "error") {
			return (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<UsersIcon />
						</EmptyMedia>
						<EmptyTitle>{t("contacts:contactsLoadError")}</EmptyTitle>
						<EmptyDescription>{errorLabel(asErrorDTO(contactsQuery.error))}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)
		}

		// The free/no-contacts account lands here — a clean empty state, never a crash.
		if (contacts.length === 0) {
			return (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<UsersIcon />
						</EmptyMedia>
						<EmptyTitle>{t("contacts:contactsEmptyTitle")}</EmptyTitle>
						<EmptyDescription>{t("contacts:contactsEmptyBody")}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)
		}

		return (
			<div
				role="listbox"
				aria-multiselectable="true"
				aria-label={t("contacts:contactsSectionContacts")}
				className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2"
			>
				{contacts.map(contact => {
					const isSelected = selected.has(contact.uuid)

					return (
						<ContactRow
							key={contact.uuid}
							contact={contact}
							selected={isSelected}
							onToggleSelect={() => {
								toggle(contact.uuid)
							}}
						>
							{isSelected ? (
								<CheckIcon
									aria-hidden="true"
									className="size-4 shrink-0 text-primary"
								/>
							) : null}
						</ContactRow>
					)
				})}
			</div>
		)
	}

	const canSubmit = selected.size > 0 && !pending

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
				<div className="flex h-72 flex-col overflow-hidden rounded-xl border border-border">{renderBody()}</div>
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
