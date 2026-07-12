import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CheckIcon, CrownIcon, SearchXIcon, UserCheckIcon, UsersIcon, UserXIcon, XIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import type { Note, NoteParticipant } from "@filen/sdk-rs"
import { isNoteOwner } from "@/features/notes/lib/actions"
import { addNoteParticipants, removeNoteParticipant, setNoteParticipantPermission } from "@/features/notes/lib/participants"
import { participantRows, contactsAvailableToAdd } from "@/features/notes/components/participantsDialog.logic"
import { useNotes } from "@/features/notes/queries/notes"
import { useAccountQuery } from "@/queries/account"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { blockContactByEmail, unblockContact } from "@/features/contacts/lib/actions"
import { deriveBlockedUsers } from "@/features/contacts/lib/blocking"
import { contactDisplayName, contactInitials, filterContactsBySearch } from "@/features/contacts/components/contactsList.logic"
// Pure selection helpers, not the drive-specific parts of the module — same generic Set<uuid> shape
// this dialog's own add-picker needs, reused rather than re-implemented (feedback: no duplicated data
// layer/logic across features for a picker this codebase already has one working copy of).
import { togglePickerContact, resolveSelectedContacts } from "@/features/drive/components/contactPickerDialog.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { ListFilterInput } from "@/components/listFilterInput"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export interface ParticipantsDialogProps {
	note: Note
	onClose: () => void
}

const SKELETON_ROW_COUNT = 3

// Note-participants panel — mounted-when-active by the surface's dialog host (useNoteDialogHost), the
// menu's owner-only "Participants" entry. Any participant can open and VIEW this dialog;
// only the owner sees the per-row permission switch, remove button, and the "Add
// participants" affordance (participantRows' canManage gate). Self-leave is intentionally NOT here —
// it stays the note menu's own dialog-routed "Leave" entry (noteMenu.logic.ts), so a participant's own
// row in this list never carries a remove control even when viewed by the owner.
export function ParticipantsDialog({ note: initialNote, onClose }: ParticipantsDialogProps) {
	const { t } = useTranslation(["notes", "contacts", "common"])
	const notesQuery = useNotes()
	const accountQuery = useAccountQuery()
	// Re-resolved from the live list cache every render so an in-dialog add/remove/permission change —
	// or a realtime participant* socket event landing while this is open — repaints immediately, never
	// the note snapshot the menu happened to be holding at open time.
	const note = notesQuery.data?.find(n => n.uuid === initialNote.uuid) ?? initialNote
	const currentUserId = accountQuery.data?.id
	const owner = isNoteOwner(note, currentUserId)

	const [mode, setMode] = useState<"list" | "add">("list")
	const [pendingUserId, setPendingUserId] = useState<bigint | null>(null)
	const [removing, setRemoving] = useState<NoteParticipant | null>(null)
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
	const [addPending, setAddPending] = useState(false)
	const [filter, setFilter] = useState("")

	// Always enabled (not mode-gated like the "add" picker's own lazy fetch below): the list
	// mode's own rows need the blocked set up front to render each row's Block/Unblock control and its
	// live "blocked" state, so the eager fetch is load-bearing here, not just a convenience. Shares one
	// query key with the picker's own read, so entering "add" mode reads warm cache instead of refetching.
	const contactsQuery = useContactsQuery({ enabled: true })
	const blockedUsers = deriveBlockedUsers(contactsQuery.data?.blocked ?? [])

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pendingUserId !== null || addPending)) {
			details.cancel()
			return
		}

		if (!next) {
			onClose()
		}
	}

	async function handleTogglePermission(participant: NoteParticipant, write: boolean): Promise<void> {
		setPendingUserId(participant.userId)
		const outcome = await setNoteParticipantPermission(note, participant, write)
		setPendingUserId(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	async function handleRemoveConfirmed(participant: NoteParticipant): Promise<void> {
		setPendingUserId(participant.userId)
		const outcome = await removeNoteParticipant(note, participant)
		setPendingUserId(null)
		setRemoving(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	// Block/unblock a participant, regardless of ownership (mobile parity: this is never gated on
	// canManage). Unblock needs the BLOCKED CONTACT's own uuid (unblockContact is uuid-keyed, unlike
	// block itself which is email-keyed) — resolved from the same warm contacts cache the row's own
	// `blocked` flag was derived from; a cache miss (the block list moved since the last render, e.g.
	// another tab unblocked them first) surfaces as an error rather than guessing a uuid.
	async function handleToggleBlock(participant: NoteParticipant, isBlockedNow: boolean): Promise<void> {
		if (isBlockedNow) {
			const blockedUuid = contactsQuery.data?.blocked.find(c => c.userId === participant.userId)?.uuid

			if (blockedUuid === undefined) {
				toast.error(
					errorLabel({ species: "plain", message: t("noteParticipantBlockStale"), label: t("noteParticipantBlockStale") })
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
		const outcome = await blockContactByEmail({
			email: participant.email,
			userId: participant.userId,
			nickName: participant.nickName,
			...(participant.avatar !== undefined ? { avatar: participant.avatar } : {})
		})
		setPendingUserId(null)

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
		// write defaults true for every add — both-clients parity (mobile's own addParticipants call
		// site, screens/noteParticipants.tsx, passes permissionsWrite: true unconditionally).
		const outcome = await addNoteParticipants(note, chosen, true)
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
		const rows = participantRows(note, currentUserId, owner, blockedUsers)

		if (rows.length === 0) {
			return (
				<Empty className="p-6">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<UsersIcon />
						</EmptyMedia>
						<EmptyTitle>{t("noteParticipantsEmpty")}</EmptyTitle>
					</EmptyHeader>
				</Empty>
			)
		}

		return (
			<ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
				{rows.map(({ participant, canManage, blocked }) => {
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
									{participant.isOwner ? (
										<CrownIcon
											aria-label={t("noteParticipantsOwnerBadge")}
											className="size-3.5 shrink-0 text-amber-500"
										/>
									) : null}
								</div>
								<p className="truncate text-xs text-muted-foreground">{participant.email}</p>
							</div>
							<div className="flex shrink-0 items-center gap-2">
								{canManage ? (
									<>
										<Switch
											checked={participant.permissionsWrite}
											disabled={rowPending}
											aria-label={t("noteParticipantsCanEditLabel", { email: participant.email })}
											onCheckedChange={checked => {
												void handleTogglePermission(participant, checked)
											}}
										/>
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={rowPending}
											aria-label={t("noteParticipantsRemoveAction", { email: participant.email })}
											onClick={() => {
												setRemoving(participant)
											}}
										>
											{rowPending ? <Spinner /> : <XIcon aria-hidden="true" />}
										</Button>
									</>
								) : null}
								{/* Block/unblock, always available regardless of ownership (mobile parity). */}
								<Button
									variant="ghost"
									size="icon-sm"
									disabled={rowPending}
									aria-label={t(blocked ? "noteParticipantsUnblockAction" : "noteParticipantsBlockAction", {
										email: participant.email
									})}
									onClick={() => {
										void handleToggleBlock(participant, blocked)
									}}
								>
									{blocked ? <UserCheckIcon aria-hidden="true" /> : <UserXIcon aria-hidden="true" />}
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

		const available = contactsAvailableToAdd(contactsQuery.data.contacts, note)

		if (available.length === 0) {
			return (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<UsersIcon />
						</EmptyMedia>
						<EmptyTitle>{t("noteParticipantsAddEmpty")}</EmptyTitle>
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
				aria-label={t("noteParticipantsAddDialogTitle")}
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
					<DialogTitle>{mode === "list" ? t("noteParticipantsDialogTitle") : t("noteParticipantsAddDialogTitle")}</DialogTitle>
					{mode === "add" ? <DialogDescription>{t("noteParticipantsAddDialogBody")}</DialogDescription> : null}
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
							{owner ? (
								<Button
									variant="outline"
									disabled={dialogPending}
									onClick={() => {
										setMode("add")
									}}
								>
									{t("noteParticipantsAddAction")}
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
								disabled={selected.size === 0 || addPending}
								onClick={() => {
									void handleAddSelected()
								}}
							>
								{addPending && <Spinner data-icon="inline-start" />}
								{t("noteParticipantsAddSubmit")}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
			{/* Nested confirm — same "must stay a child of the outer Dialog" rule as versionsDialog.tsx. */}
			<ConfirmDialog
				open={removing !== null}
				pending={pendingUserId !== null}
				title={t("noteParticipantRemoveDialogTitle")}
				body={t("noteParticipantRemoveDialogBody", { email: removing?.email ?? "" })}
				confirmLabel={t("noteParticipantRemoveDialogConfirm")}
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
