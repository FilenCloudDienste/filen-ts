import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CrownIcon, UserCheckIcon, UsersIcon, UserXIcon, XIcon } from "lucide-react"
import type { Note, NoteParticipant } from "@filen/sdk-rs"
import { isNoteOwner } from "@/features/notes/lib/sort"
import { addNoteParticipants, removeNoteParticipant, setNoteParticipantPermission } from "@/features/notes/lib/participants"
import { participantRows } from "@/features/notes/components/participantsDialog.logic"
import { useLiveNote } from "@/features/notes/queries/notes"
import { useAccountQuery } from "@/queries/account"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { toggleParticipantBlocked } from "@/features/contacts/lib/actions"
import { ContactPickerList } from "@/features/contacts/components/contactPickerList"
import { contactDisplayName, deriveBlockedUsers } from "@filen/shared"
import { togglePickerContact, resolveSelectedContacts } from "@/features/contacts/lib/contactPicker.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { plainErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { UserAvatar } from "@/components/userAvatar"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { EmptyMessage } from "@/components/emptyMessage"

export interface ParticipantsDialogProps {
	note: Note
	onClose: () => void
}

// Note-participants panel — mounted-when-active by the surface's dialog host (useNoteDialogHost), the
// menu's owner-only "Participants" entry. Any participant can open and VIEW this dialog;
// only the owner sees the per-row permission switch, remove button, and the "Add
// participants" affordance (participantRows' canManage gate). Self-leave is intentionally NOT here —
// it stays the note menu's own dialog-routed "Leave" entry (noteMenu.logic.ts), so a participant's own
// row in this list never carries a remove control even when viewed by the owner.
export function ParticipantsDialog({ note: initialNote, onClose }: ParticipantsDialogProps) {
	const { t } = useTranslation(["notes", "common"])
	const isOnline = useIsOnline()
	const accountQuery = useAccountQuery()
	const note = useLiveNote(initialNote)
	const currentUserId = accountQuery.data?.id
	const owner = isNoteOwner(note, currentUserId)

	const [mode, setMode] = useState<"list" | "add">("list")
	// The one participant operation in flight. A single slot, so every row's controls lock while it
	// runs: a second operation started meanwhile would share it, and the first to finish would clear it
	// under the other (re-enabling that row mid-write and letting the dialog close).
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

	const dialogPending = pendingUserId !== null || addPending

	const handleOpenChange = pendingGuardedOpenChange(dialogPending, next => {
		if (!next) {
			onClose()
		}
	})

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
	// canManage).
	async function handleToggleBlock(participant: NoteParticipant, isBlockedNow: boolean): Promise<void> {
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

	async function handleAddSelected(): Promise<void> {
		const chosen = resolveSelectedContacts(contactsQuery.data?.contacts ?? [], selected)

		if (chosen.length === 0) {
			return
		}

		setAddPending(true)
		const outcome = await addNoteParticipants(note, chosen)
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
				<EmptyMessage
					className="p-6"
					icon={UsersIcon}
					title={t("noteParticipantsEmpty")}
				/>
			)
		}

		return (
			<ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
				{rows.map(({ participant, canManage, blocked }) => {
					const displayName = contactDisplayName(participant)
					// Only picks the row that shows the spinner; every row is disabled while anything is pending.
					const rowPending = pendingUserId === participant.userId

					return (
						<li
							key={participant.userId.toString()}
							className="flex items-center gap-3 rounded-xl px-2 py-2 text-sm"
						>
							<UserAvatar
								src={participant.avatar}
								name={displayName}
							/>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-1.5">
									<p className="truncate font-medium">{displayName}</p>
									{participant.isOwner ? (
										<CrownIcon
											aria-label={t("common:participantOwnerBadge")}
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
											disabled={dialogPending || !isOnline}
											title={!isOnline ? t("common:offlineActionDisabled") : undefined}
											aria-label={t("noteParticipantsCanEditLabel", { email: participant.email })}
											onCheckedChange={checked => {
												void handleTogglePermission(participant, checked)
											}}
										/>
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={dialogPending || !isOnline}
											title={!isOnline ? t("common:offlineActionDisabled") : undefined}
											aria-label={t("common:participantRemoveAction", { email: participant.email })}
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
									disabled={dialogPending || !isOnline}
									title={!isOnline ? t("common:offlineActionDisabled") : undefined}
									aria-label={t(blocked ? "common:participantUnblockAction" : "common:participantBlockAction", {
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
					{mode === "add" ? <DialogDescription>{t("noteParticipantsAddDialogBody")}</DialogDescription> : null}
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
						exclude={note.participants}
					/>
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
			{/* Nested confirm — same "must stay a child of the outer Dialog" rule as versionsDialog.tsx. */}
			<ConfirmDialog
				open={removing !== null}
				pending={pendingUserId !== null}
				title={t("common:participantRemoveDialogTitle")}
				body={t("noteParticipantRemoveDialogBody", { email: removing?.email ?? "" })}
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
		</Dialog>
	)
}
