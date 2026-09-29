import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CheckIcon, CrownIcon, UserCheckIcon, UsersIcon, UserXIcon, XIcon } from "lucide-react"
import type { Chat, ChatParticipant } from "@filen/sdk-rs"
import { cn, contactDisplayName, deriveBlockedUsers } from "@filen/shared"
import { isChatOwner } from "@/features/chats/lib/actions"
import { addChatParticipants, removeChatParticipant, removeChatParticipants } from "@/features/chats/lib/participants"
import { chatParticipantRows, selectedParticipantsForRemoval } from "@/features/chats/components/chatParticipantsDialog.logic"
import { toastChatParticipantsBulkRemoveOutcome } from "@/features/chats/lib/bulkToast"
import { useChats } from "@/features/chats/queries/chats"
import { useAccountQuery } from "@/queries/account"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { toggleParticipantBlocked } from "@/features/contacts/lib/actions"
import { ContactPickerList } from "@/features/contacts/components/contactPickerList"
// Reused for BOTH modes: `selected` holds contact uuids in "add" mode and participant userId strings in
// "list" mode — the two are never active at once and every mode transition below resets the Set, so the
// two id spaces never collide.
import { togglePickerContact, resolveSelectedContacts } from "@/features/contacts/lib/contactPicker.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { plainErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { onActivateKey } from "@/lib/rowKeys"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { UserAvatar } from "@/components/userAvatar"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { EmptyMessage } from "@/components/emptyMessage"

export interface ChatParticipantsDialogProps {
	chat: Chat
	onClose: () => void
}

// Conversation-participants panel — mounted-when-active by the surface's dialog host
// (useChatDialogHost), the menu's "Participants" entry. Any participant can open and VIEW this
// dialog; only the owner sees the per-row remove button and the "Add participants" affordance
// (chatParticipantRows' canManage gate — verified against mobile's chatParticipants.tsx). Self-leave
// is intentionally NOT here — it stays the chat menu's own dialog-routed "Leave"/"Delete" entry, so
// the viewer's own row never appears in this list at all (chatParticipantRows' self-exclusion).
export function ChatParticipantsDialog({ chat: initialChat, onClose }: ChatParticipantsDialogProps) {
	const { t } = useTranslation(["chats", "common"])
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
	const [filter, setFilter] = useState("")
	const [bulkRemovePending, setBulkRemovePending] = useState(false)
	const [confirmingBulkRemove, setConfirmingBulkRemove] = useState(false)

	// Always enabled (not mode-gated like the "add" picker alone would need): list mode's rows need the
	// blocked set up front for each row's Block/Unblock control and its live state. Shares one query key
	// with the picker's read, so entering "add" mode reads warm cache instead of refetching.
	const contactsQuery = useContactsQuery({ enabled: true })
	const blockedUsers = deriveBlockedUsers(contactsQuery.data?.blocked ?? [])
	// Computed once at the top level (not just inside renderListBody) — the footer's bulk-remove button
	// and its confirm dialog both need to resolve `selected` back to concrete participants too.
	const rows = chatParticipantRows(chat, currentUserId, owner, blockedUsers)
	const selectedForRemoval = selectedParticipantsForRemoval(rows, selected)

	const handleOpenChange = pendingGuardedOpenChange(pendingUserId !== null || addPending || bulkRemovePending, next => {
		if (!next) {
			onClose()
		}
	})

	async function handleRemoveConfirmed(participant: ChatParticipant): Promise<void> {
		setPendingUserId(participant.userId)
		const outcome = await removeChatParticipant(chat, participant)
		setPendingUserId(null)
		setRemoving(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	// Block/unblock a participant, regardless of ownership (mobile parity: never gated on canManage).
	async function handleToggleBlock(participant: ChatParticipant, isBlockedNow: boolean): Promise<void> {
		const toggled = toggleParticipantBlocked(participant, contactsQuery.data?.blocked, isBlockedNow)

		if (toggled === "stale") {
			toast.error(errorLabel(plainErrorDTO(t("common:participantBlockStale"))))

			return
		}

		setPendingUserId(participant.userId)
		const outcome = await toggled
		setPendingUserId(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	async function handleBulkRemoveConfirmed(): Promise<void> {
		if (selectedForRemoval.length === 0) {
			setConfirmingBulkRemove(false)
			return
		}

		setBulkRemovePending(true)
		const { outcome } = await removeChatParticipants(chat, selectedForRemoval)
		setBulkRemovePending(false)
		setConfirmingBulkRemove(false)

		toastChatParticipantsBulkRemoveOutcome(outcome)

		// Mirrors the notes/chats bulk-bar convention: a succeeded participant is pruned from the
		// selection, a failed one stays selected so the user can retry without re-picking it.
		const removedIds = new Set(outcome.succeeded.map(p => p.userId.toString()))
		setSelected(prev => {
			const next = new Set(prev)

			for (const id of removedIds) {
				next.delete(id)
			}

			return next
		})
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
		setFilter("")
		setMode("list")
	}

	function renderListBody() {
		if (rows.length === 0) {
			return (
				<EmptyMessage
					className="p-6"
					icon={UsersIcon}
					title={t("chatParticipantsEmpty")}
				/>
			)
		}

		return (
			<ul
				role="listbox"
				aria-multiselectable="true"
				aria-label={t("common:participantsDialogTitle")}
				className="flex max-h-80 flex-col gap-0.5 overflow-y-auto"
			>
				{rows.map(({ participant, canManage, isOwner: rowIsOwner, blocked }) => {
					const displayName = contactDisplayName(participant)
					const rowPending = pendingUserId === participant.userId
					const participantKey = participant.userId.toString()
					// Row-click multi-select (reuses the add-picker's own `selected` Set/id-toggle idiom, see
					// the import comment above) — owner-only, since only a manageable row can ever be bulk
					// removed. A non-manageable row (participant viewer, or the owner's own excluded row)
					// stays a static, unclickable list item.
					const isSelected = canManage && selected.has(participantKey)

					function toggleRowSelected(): void {
						if (!canManage) {
							return
						}

						setSelected(prev => togglePickerContact(prev, participantKey))
					}

					return (
						<li
							key={participantKey}
							role={canManage ? "option" : undefined}
							aria-selected={canManage ? isSelected : undefined}
							tabIndex={canManage ? 0 : undefined}
							onClick={canManage ? toggleRowSelected : undefined}
							onKeyDown={canManage ? onActivateKey(toggleRowSelected) : undefined}
							className={cn(
								"flex items-center gap-3 rounded-xl px-2 py-2 text-sm outline-none",
								canManage && "focus-ring-row select-none",
								isSelected && "bg-accent text-accent-foreground"
							)}
						>
							<UserAvatar
								src={participant.avatar}
								name={displayName}
							/>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-1.5">
									<p className="truncate font-medium">{displayName}</p>
									{rowIsOwner ? (
										<CrownIcon
											aria-label={t("common:participantOwnerBadge")}
											className="size-3.5 shrink-0 text-amber-500"
										/>
									) : null}
								</div>
								<p className="truncate text-xs text-muted-foreground">
									{blocked ? `${participant.email} · ${t("chatParticipantBlockedMarker")}` : participant.email}
								</p>
							</div>
							<div className="flex shrink-0 items-center gap-1">
								{isSelected ? (
									<CheckIcon
										aria-hidden="true"
										className="size-4 shrink-0 text-primary"
									/>
								) : canManage ? (
									<Button
										variant="ghost"
										size="icon-sm"
										disabled={rowPending || !isOnline}
										aria-label={t("common:participantRemoveAction", { email: participant.email })}
										title={!isOnline ? t("common:offlineActionDisabled") : undefined}
										onClick={event => {
											// Stop the toggle-select handler on the row itself from also firing —
											// this button dispatches the single-item quick-remove flow instead.
											event.stopPropagation()
											setRemoving(participant)
										}}
									>
										{rowPending ? <Spinner /> : <XIcon aria-hidden="true" />}
									</Button>
								) : null}
								{/* Block/unblock, always present regardless of ownership (mobile parity). */}
								<Button
									variant="ghost"
									size="icon-sm"
									disabled={rowPending || !isOnline}
									aria-label={t(blocked ? "common:participantUnblockAction" : "common:participantBlockAction", {
										email: participant.email
									})}
									title={!isOnline ? t("common:offlineActionDisabled") : undefined}
									onClick={event => {
										// Same rationale as the remove button's stop — an owner-manageable row is a
										// click-toggle, so without this a block click would also flip its selection.
										event.stopPropagation()
										void handleToggleBlock(participant, blocked)
									}}
								>
									{rowPending ? (
										<Spinner />
									) : blocked ? (
										<UserCheckIcon aria-hidden="true" />
									) : (
										<UserXIcon aria-hidden="true" />
									)}
								</Button>
							</div>
						</li>
					)
				})}
			</ul>
		)
	}

	const dialogPending = pendingUserId !== null || addPending || bulkRemovePending

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
					<DialogTitle>
						{mode === "list" ? t("common:participantsDialogTitle") : t("common:participantsAddDialogTitle")}
					</DialogTitle>
					{mode === "add" ? <DialogDescription>{t("chatParticipantsAddDialogBody")}</DialogDescription> : null}
				</DialogHeader>
				{mode === "list" ? (
					renderListBody()
				) : (
					<ContactPickerList
						contactsQuery={contactsQuery}
						filter={filter}
						onFilterChange={setFilter}
						selected={selected}
						onToggle={uuid => {
							setSelected(prev => togglePickerContact(prev, uuid))
						}}
						ariaLabel={t("common:participantsAddDialogTitle")}
						emptyTitle={t("common:participantsAddEmpty")}
						exclude={chat.participants}
					/>
				)}
				<DialogFooter>
					{mode === "list" ? (
						<>
							{owner && selectedForRemoval.length > 0 ? (
								<Button
									variant="destructive"
									disabled={dialogPending || !isOnline}
									title={!isOnline ? t("common:offlineActionDisabled") : undefined}
									onClick={() => {
										setConfirmingBulkRemove(true)
									}}
								>
									{bulkRemovePending && <Spinner data-icon="inline-start" />}
									{t("chatParticipantsRemoveSelectedAction", { count: selectedForRemoval.length })}
								</Button>
							) : null}
							{owner ? (
								<Button
									variant="outline"
									disabled={dialogPending || !isOnline}
									title={!isOnline ? t("common:offlineActionDisabled") : undefined}
									onClick={() => {
										// A stale list-mode selection (participant userId strings) must never leak
										// into the add-picker below, which reuses the same `selected` Set for
										// contact uuids — see the shared-Set rationale in the import comment above.
										setSelected(new Set())
										setMode("add")
									}}
								>
									{t("common:participantsAddAction")}
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
									setFilter("")
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
								{t("common:participantsAddSubmit")}
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
				title={t("common:participantRemoveDialogTitle")}
				body={t("chatParticipantRemoveDialogBody", { email: removing?.email ?? "" })}
				confirmLabel={t("common:participantRemoveDialogConfirm")}
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
			{/* Second nested confirm — same "must stay a child of the outer Dialog" rule, the bulk
			counterpart of the single-row confirm above. */}
			<ConfirmDialog
				open={confirmingBulkRemove}
				pending={bulkRemovePending}
				title={t("chatParticipantRemoveSelectedDialogTitle")}
				body={t("chatParticipantRemoveSelectedDialogBody", { count: selectedForRemoval.length })}
				confirmLabel={t("common:participantRemoveDialogConfirm")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					if (!open) {
						setConfirmingBulkRemove(false)
					}
				}}
				onConfirm={() => {
					void handleBulkRemoveConfirmed()
				}}
			/>
		</Dialog>
	)
}
