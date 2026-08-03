import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CheckIcon, CrownIcon, SearchXIcon, UserCheckIcon, UsersIcon, UserXIcon, XIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import type { Chat, ChatParticipant } from "@filen/sdk-rs"
import { cn } from "@/lib/utils"
import { isChatOwner } from "@/features/chats/lib/actions"
import { addChatParticipants, removeChatParticipant, removeChatParticipants } from "@/features/chats/lib/participants"
import {
	chatParticipantRows,
	contactsAvailableToAddToChat,
	selectedParticipantsForRemoval
} from "@/features/chats/components/chatParticipantsDialog.logic"
import { toastChatParticipantsBulkRemoveOutcome } from "@/features/chats/lib/bulkToast"
import { useChats } from "@/features/chats/queries/chats"
import { useAccountQuery } from "@/queries/account"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { blockContactByEmail, unblockContact } from "@/features/contacts/lib/actions"
import { deriveBlockedUsers } from "@/features/contacts/lib/blocking"
import { contactDisplayName, contactInitials, filterContactsBySearch } from "@/features/contacts/components/contactsList.logic"
// Same generic Set<uuid> picker helpers notes' own participantsDialog.tsx reuses — not re-implemented
// here either (feedback: no duplicated selection/data layer across features for a picker this
// codebase already has one working copy of). Reused for BOTH modes now: `selected` holds contact uuids
// in "add" mode and participant userId strings in "list" mode — the two are mutually exclusive (never
// active at once) and every mode transition below resets the Set, so the two id spaces never collide.
import { togglePickerContact, resolveSelectedContacts } from "@/features/drive/components/contactPickerDialog.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { ListFilterInput } from "@/components/listFilterInput"
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

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pendingUserId !== null || addPending || bulkRemovePending)) {
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

	// Block/unblock a participant, regardless of ownership (mobile parity: never gated on canManage).
	// Unblock needs the BLOCKED CONTACT's own uuid (unblockContact is uuid-keyed, unlike block itself which
	// is email-keyed) — resolved from the same warm contacts cache the row's `blocked` flag came from; a
	// miss (the block list moved since the last render) surfaces as an error rather than a guessed uuid.
	async function handleToggleBlock(participant: ChatParticipant, isBlockedNow: boolean): Promise<void> {
		if (isBlockedNow) {
			const blockedUuid = contactsQuery.data?.blocked.find(c => c.userId === participant.userId)?.uuid

			if (blockedUuid === undefined) {
				toast.error(
					errorLabel({
						species: "plain",
						message: t("chatParticipantBlockStale"),
						label: t("chatParticipantBlockStale")
					})
				)

				return
			}

			setPendingUserId(participant.userId)
			const outcome = await unblockContact(blockedUuid)
			setPendingUserId(null)

			if (outcome.status === "error") {
				toast.error(errorLabel(outcome.dto))
			}

			return
		}

		setPendingUserId(participant.userId)
		// ChatParticipant.nickName/avatar are REQUIRED keys that may hold undefined, and
		// exactOptionalPropertyTypes rejects passing undefined into BlockIdentity's optional fields — hence
		// the spread guards (notes' NoteParticipant.nickName is a plain string, so its copy needs none).
		const outcome = await blockContactByEmail({
			email: participant.email,
			userId: participant.userId,
			...(participant.nickName !== undefined ? { nickName: participant.nickName } : {}),
			...(participant.avatar !== undefined ? { avatar: participant.avatar } : {})
		})
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
			<ul
				role="listbox"
				aria-multiselectable="true"
				aria-label={t("chatParticipantsDialogTitle")}
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
							onKeyDown={
								canManage
									? event => {
											// Enter/Space here is the ROW's own select gesture; a keydown that bubbled up
											// from a control inside the row belongs to that control, and preventDefault
											// would cancel its activation click.
											if (event.target !== event.currentTarget) {
												return
											}

											if (event.key !== "Enter" && event.key !== " ") {
												return
											}

											event.preventDefault()
											toggleRowSelected()
										}
									: undefined
							}
							className={cn(
								"flex items-center gap-3 rounded-xl px-2 py-2 text-sm outline-none",
								canManage && "cursor-pointer focus-ring-row select-none",
								isSelected && "bg-accent text-accent-foreground"
							)}
						>
							<Avatar>
								{/* crossOrigin: require-corp COEP needs a CORS-mode request for this cross-origin
								    egest url (see settings/account/avatarCard.tsx's matching comment). */}
								{participant.avatar !== undefined ? (
									<AvatarImage
										src={participant.avatar}
										crossOrigin="anonymous"
									/>
								) : null}
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
										aria-label={t("chatParticipantRemoveAction", { email: participant.email })}
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
									aria-label={t(blocked ? "chatParticipantsUnblockAction" : "chatParticipantsBlockAction", {
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

		const filteredAvailable = filterContactsBySearch(available, filter)

		// A non-matching filter gets its own "no results" state, distinct from the "everyone's
		// already a participant" branch above.
		if (filteredAvailable.length === 0) {
			return (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<SearchXIcon />
						</EmptyMedia>
						<EmptyTitle>{t("contacts:contactsSearchNoResultsTitle")}</EmptyTitle>
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
				{filteredAvailable.map(contact => {
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
							className="flex h-14 cursor-pointer items-center gap-3 rounded-xl px-2 text-sm focus-ring-row outline-none select-none aria-selected:bg-accent aria-selected:text-accent-foreground"
						>
							<Avatar>
								{/* crossOrigin: require-corp COEP needs a CORS-mode request for this cross-origin
								    egest url (see settings/account/avatarCard.tsx's matching comment). */}
								{contact.avatar !== undefined ? (
									<AvatarImage
										src={contact.avatar}
										crossOrigin="anonymous"
									/>
								) : null}
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
					<DialogTitle>{mode === "list" ? t("chatParticipantsDialogTitle") : t("chatParticipantsAddDialogTitle")}</DialogTitle>
					{mode === "add" ? <DialogDescription>{t("chatParticipantsAddDialogBody")}</DialogDescription> : null}
				</DialogHeader>
				{mode === "list" ? (
					renderListBody()
				) : (
					<>
						<ListFilterInput
							value={filter}
							onChange={setFilter}
							placeholder={t("contacts:contactsSearchPlaceholder")}
							ariaLabel={t("contacts:contactsSearchPlaceholder")}
						/>
						<div className="flex h-72 flex-col overflow-hidden rounded-xl ring-1 ring-foreground/5 dark:ring-foreground/10">
							{renderAddBody()}
						</div>
					</>
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
			{/* Second nested confirm — same "must stay a child of the outer Dialog" rule, the bulk
			counterpart of the single-row confirm above. */}
			<ConfirmDialog
				open={confirmingBulkRemove}
				pending={bulkRemovePending}
				title={t("chatParticipantRemoveSelectedDialogTitle")}
				body={t("chatParticipantRemoveSelectedDialogBody", { count: selectedForRemoval.length })}
				confirmLabel={t("chatParticipantRemoveDialogConfirm")}
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
