import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CheckIcon, UsersIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import type { Chat } from "@filen/sdk-rs"
import { createChat } from "@/features/chats/lib/actions"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { togglePickerContact, resolveSelectedContacts } from "@/features/drive/components/contactPickerDialog.logic"
import { ContactRow } from "@/features/contacts/components/contactRow"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export interface CreateChatDialogProps {
	onClose: () => void
	// Fires once createChat resolves successfully — the mounting host (useChatDialogHost) navigates to
	// the new conversation and closes the dialog; this component owns neither concern itself.
	onCreated: (chat: Chat) => void
}

const SKELETON_ROW_COUNT = 5

// New-conversation contact picker — mounted-when-active by the sidebar's "New chat" button via
// useChatDialogHost's "create" kind. Multi-selects from the established contact list (reusing
// ContactRow's avatar/name/presence visuals, same as drive's ContactPickerDialog) and calls createChat
// with every chosen contact. Picker treats 0 selections as cancel — createChat is NEVER called with an
// empty array (the SDK sees no call at all until at least one contact is selected), matching both
// mobile and old-web. The zero-contacts FREE e2e account lands on this dialog's own
// empty state, never a crash — the one thing this flow is confidently e2e-provable up to.
export function CreateChatDialog({ onClose, onCreated }: CreateChatDialogProps) {
	const { t } = useTranslation(["chats", "contacts", "common"])
	const contactsQuery = useContactsQuery()
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
	const [pending, setPending] = useState(false)

	const contacts = contactsQuery.data?.contacts ?? []

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pending)) {
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

		// The zero-contacts FREE account lands here — a clean empty state, never a crash.
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
					<DialogTitle>{t("chatCreateDialogTitle")}</DialogTitle>
					<DialogDescription>{t("chatCreateDialogBody")}</DialogDescription>
				</DialogHeader>
				<div className="flex h-72 flex-col overflow-hidden rounded-xl ring-1 ring-foreground/5 dark:ring-foreground/10">
					{renderBody()}
				</div>
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
