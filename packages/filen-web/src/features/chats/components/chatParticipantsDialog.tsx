import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CheckIcon, CrownIcon, UsersIcon, XIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import type { Chat, ChatParticipant } from "@filen/sdk-rs"
import { isChatOwner } from "@/features/chats/lib/actions"
import { addChatParticipants, removeChatParticipant } from "@/features/chats/lib/participants"
import { chatParticipantRows, contactsAvailableToAddToChat } from "@/features/chats/components/chatParticipantsDialog.logic"
import { useChats } from "@/features/chats/queries/chats"
import { useAccountQuery } from "@/queries/account"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { contactDisplayName, contactInitials } from "@/features/contacts/components/contactsList.logic"
// Same generic Set<uuid> picker helpers notes' own participantsDialog.tsx reuses — not re-implemented
// here either (feedback: no duplicated selection/data layer across features for a picker this
// codebase already has one working copy of).
import { togglePickerContact, resolveSelectedContacts } from "@/features/drive/components/contactPickerDialog.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export interface ChatParticipantsDialogProps {
	chat: Chat
	onClose: () => void
}

const SKELETON_ROW_COUNT = 3

// Conversation-participants panel — mounted-when-active by the surface's dialog host
// (useChatDialogHost), the menu's "Participants" entry. Any participant can open and VIEW this
// dialog; only the owner sees the per-row remove button and the "Add participants" affordance
// (chatParticipantRows' canManage gate — verified against mobile's chatParticipants.tsx). Self-leave
// is intentionally NOT here — it stays the chat menu's own dialog-routed "Leave"/"Delete" entry, so
// the viewer's own row never appears in this list at all (chatParticipantRows' self-exclusion).
export function ChatParticipantsDialog({ chat: initialChat, onClose }: ChatParticipantsDialogProps) {
	const { t } = useTranslation(["chats", "contacts", "common"])
	const isOnline = useIsOnline()
	const chatsQuery = useChats()
	const accountQuery = useAccountQuery()
	// Re-resolved from the live list cache every render so an in-dialog add/remove — or a realtime
	// participant* socket event landing while this is open (socketHandlers.ts's conversationParticipantNew/
	// conversationParticipantLeft handlers) — repaints immediately, never
	// the chat snapshot the menu happened to be holding at open time.
	const chat = chatsQuery.data?.find(c => c.uuid === initialChat.uuid) ?? initialChat
	const currentUserId = accountQuery.data?.id
	const owner = isChatOwner(chat, currentUserId)

	const [mode, setMode] = useState<"list" | "add">("list")
	const [pendingUserId, setPendingUserId] = useState<bigint | null>(null)
	const [removing, setRemoving] = useState<ChatParticipant | null>(null)
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
	const [addPending, setAddPending] = useState(false)

	const contactsQuery = useContactsQuery({ enabled: mode === "add" })

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pendingUserId !== null || addPending)) {
			details.cancel()
			return
		}

		if (!next) {
			onClose()
		}
	}

	async function handleRemoveConfirmed(participant: ChatParticipant): Promise<void> {
		setPendingUserId(participant.userId)
		const outcome = await removeChatParticipant(chat, participant)
		setPendingUserId(null)
		setRemoving(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	async function handleAddSelected(): Promise<void> {
		const chosen = resolveSelectedContacts(contactsQuery.data?.contacts ?? [], selected)

		if (chosen.length === 0) {
			return
		}

		setAddPending(true)
		const outcome = await addChatParticipants(chat, chosen)
		setAddPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		setSelected(new Set())
		setMode("list")
	}

	function renderListBody() {
		const rows = chatParticipantRows(chat, currentUserId, owner)

		if (rows.length === 0) {
			return (
				<Empty className="p-6">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<UsersIcon />
						</EmptyMedia>
						<EmptyTitle>{t("chatParticipantsEmpty")}</EmptyTitle>
					</EmptyHeader>
				</Empty>
			)
		}

		return (
			<ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
				{rows.map(({ participant, canManage, isOwner: rowIsOwner }) => {
					const displayName = contactDisplayName(participant)
					const rowPending = pendingUserId === participant.userId

					return (
						<li
							key={participant.userId.toString()}
							className="flex items-center gap-3 rounded-xl px-2 py-2 text-sm"
						>
							<Avatar>
								{participant.avatar !== undefined ? <AvatarImage src={participant.avatar} /> : null}
								<AvatarFallback>{contactInitials(displayName)}</AvatarFallback>
							</Avatar>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-1.5">
									<p className="truncate font-medium">{displayName}</p>
									{rowIsOwner ? (
										<CrownIcon
											aria-label={t("chatParticipantsOwnerBadge")}
											className="size-3.5 shrink-0 text-amber-500"
										/>
									) : null}
								</div>
								<p className="truncate text-xs text-muted-foreground">{participant.email}</p>
							</div>
							{canManage ? (
								<Button
									variant="ghost"
									size="icon-sm"
									disabled={rowPending || !isOnline}
									aria-label={t("chatParticipantRemoveAction", { email: participant.email })}
									title={!isOnline ? t("common:offlineActionDisabled") : undefined}
									onClick={() => {
										setRemoving(participant)
									}}
								>
									{rowPending ? <Spinner /> : <XIcon aria-hidden="true" />}
								</Button>
							) : null}
						</li>
					)
				})}
			</ul>
		)
	}

	function renderAddBody() {
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

		const available = contactsAvailableToAddToChat(contactsQuery.data.contacts, chat)

		if (available.length === 0) {
			return (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<UsersIcon />
						</EmptyMedia>
						<EmptyTitle>{t("chatParticipantsAddEmpty")}</EmptyTitle>
					</EmptyHeader>
				</Empty>
			)
		}

		return (
			<div
				role="listbox"
				aria-multiselectable="true"
				aria-label={t("chatParticipantsAddDialogTitle")}
				className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2"
			>
				{available.map(contact => {
					const isSelected = selected.has(contact.uuid)
					const displayName = contactDisplayName(contact)

					return (
						<div
							key={contact.uuid}
							role="option"
							aria-selected={isSelected}
							tabIndex={0}
							onClick={() => {
								setSelected(prev => togglePickerContact(prev, contact.uuid))
							}}
							onKeyDown={event => {
								if (event.key !== "Enter" && event.key !== " ") {
									return
								}

								event.preventDefault()
								setSelected(prev => togglePickerContact(prev, contact.uuid))
							}}
							className="flex h-14 cursor-pointer items-center gap-3 rounded-xl px-2 text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-selected:bg-accent aria-selected:text-accent-foreground"
						>
							<Avatar>
								{contact.avatar !== undefined ? <AvatarImage src={contact.avatar} /> : null}
								<AvatarFallback>{contactInitials(displayName)}</AvatarFallback>
							</Avatar>
							<div className="min-w-0 flex-1">
								<p className="truncate font-medium">{displayName}</p>
								<p className="truncate text-xs text-muted-foreground">{contact.email}</p>
							</div>
							{isSelected ? (
								<CheckIcon
									aria-hidden="true"
									className="size-4 shrink-0 text-primary"
								/>
							) : null}
						</div>
					)
				})}
			</div>
		)
	}

	const dialogPending = pendingUserId !== null || addPending

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent
				closeButtonDisabled={dialogPending}
				className="sm:max-w-lg"
			>
				<DialogHeader>
					<DialogTitle>{mode === "list" ? t("chatParticipantsDialogTitle") : t("chatParticipantsAddDialogTitle")}</DialogTitle>
					{mode === "add" ? <DialogDescription>{t("chatParticipantsAddDialogBody")}</DialogDescription> : null}
				</DialogHeader>
				{mode === "list" ? (
					renderListBody()
				) : (
					<div className="flex h-72 flex-col overflow-hidden rounded-xl ring-1 ring-foreground/5 dark:ring-foreground/10">
						{renderAddBody()}
					</div>
				)}
				<DialogFooter>
					{mode === "list" ? (
						<>
							{owner ? (
								<Button
									variant="outline"
									disabled={dialogPending || !isOnline}
									title={!isOnline ? t("common:offlineActionDisabled") : undefined}
									onClick={() => {
										setMode("add")
									}}
								>
									{t("chatParticipantsAddAction")}
								</Button>
							) : null}
							<Button
								variant={owner ? "ghost" : "outline"}
								disabled={dialogPending}
								onClick={onClose}
							>
								{t("common:close")}
							</Button>
						</>
					) : (
						<>
							<Button
								variant="outline"
								disabled={addPending}
								onClick={() => {
									setSelected(new Set())
									setMode("list")
								}}
							>
								{t("common:cancel")}
							</Button>
							<Button
								disabled={selected.size === 0 || addPending || !isOnline}
								title={!isOnline ? t("common:offlineActionDisabled") : undefined}
								onClick={() => {
									void handleAddSelected()
								}}
							>
								{addPending && <Spinner data-icon="inline-start" />}
								{t("chatParticipantsAddSubmit")}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
			{/* Nested confirm — same "must stay a child of the outer Dialog" rule as notes' own
			participantsDialog.tsx. */}
			<ConfirmDialog
				open={removing !== null}
				pending={pendingUserId !== null}
				title={t("chatParticipantRemoveDialogTitle")}
				body={t("chatParticipantRemoveDialogBody", { email: removing?.email ?? "" })}
				confirmLabel={t("chatParticipantRemoveDialogConfirm")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					if (!open) {
						setRemoving(null)
					}
				}}
				onConfirm={() => {
					if (removing) {
						void handleRemoveConfirmed(removing)
					}
				}}
			/>
		</Dialog>
	)
}
