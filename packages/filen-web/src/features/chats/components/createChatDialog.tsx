import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { Chat } from "@filen/sdk-rs"
import { toggleInSet } from "@filen/shared"
import { createChat } from "@/features/chats/lib/actions"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { resolveSelectedContacts } from "@/features/contacts/lib/contactPicker.logic"
import { ContactPickerList } from "@/features/contacts/components/contactPickerList"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export interface CreateChatDialogProps {
	onClose: () => void
	// Fires once createChat resolves successfully — the mounting host (useChatDialogHost) navigates to
	// the new conversation and closes the dialog; this component owns neither concern itself.
	onCreated: (chat: Chat) => void
}

// New-conversation contact picker — mounted-when-active by the sidebar's "New chat" button via
// useChatDialogHost's "create" kind. Multi-selects from the established contact list (ContactPickerList,
// same as drive's ContactPickerDialog) and calls createChat with every chosen contact. Picker treats 0
// selections as cancel — createChat is NEVER called with an empty array (the SDK sees no call at all
// until at least one contact is selected), matching both mobile and old-web. The zero-contacts FREE e2e
// account lands on this dialog's own empty state, never a crash — the one thing this flow is
// confidently e2e-provable up to.
export function CreateChatDialog({ onClose, onCreated }: CreateChatDialogProps) {
	const { t } = useTranslation(["chats", "contacts", "common"])
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

	async function handleCreate(): Promise<void> {
		const chosen = resolveSelectedContacts(contacts, selected)

		if (chosen.length === 0) {
			return
		}

		setPending(true)
		const outcome = await createChat(chosen)
		setPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		onCreated(outcome.item)
	}

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
					<DialogTitle>{t("chatCreateDialogTitle")}</DialogTitle>
					<DialogDescription>{t("chatCreateDialogBody")}</DialogDescription>
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
							void handleCreate()
						}}
					>
						{pending && <Spinner data-icon="inline-start" />}
						{t("chatCreateDialogSubmit")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
