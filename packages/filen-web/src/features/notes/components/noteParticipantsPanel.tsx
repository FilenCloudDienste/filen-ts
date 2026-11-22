import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { MinusIcon, PlusIcon, UserCheckIcon, UserXIcon } from "lucide-react"
import type { Contact, Note, NoteParticipant } from "@filen/sdk-rs"
import { contactDisplayName, deriveBlockedUsers } from "@filen/shared"
import { isNoteOwner } from "@/features/notes/lib/sort"
import { addNoteParticipants, removeNoteParticipant, setNoteParticipantPermission } from "@/features/notes/lib/participants"
import {
	participantPermission,
	participantRows,
	type ParticipantPermission,
	type ParticipantRowModel
} from "@/features/notes/components/noteParticipantsPanel.logic"
import { noteParticipantsPanel } from "@/features/notes/store/useNoteParticipantsPanel"
import { useAccountQuery } from "@/queries/account"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { toggleParticipantBlocked } from "@/features/contacts/lib/actions"
import { ParticipantsAddView } from "@/features/contacts/components/participantsAddView"
import { DockedSidePanel, SidePanelSurface, type DockedSurfaceProps } from "@/features/shell/components/dockedSidePanel"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { plainErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { UserAvatar } from "@/components/userAvatar"
import { Spinner } from "@/components/ui/spinner"

const ADD_BUTTON_ID = "note-participants-add"

const PERMISSIONS: readonly ParticipantPermission[] = ["edit", "view"]

// The one participant operation in flight. A single slot, so every row's controls lock while it runs: a second
// operation started meanwhile would share it, and the first to finish would clear it under the other. `write` is a
// permission change's target, shown in its select until the write settles.
interface PendingOperation {
	userId: bigint
	write?: boolean
}

// Who is on the note and, for its owner, who may edit it: every participant (the viewer's own row first, labelled as
// theirs), a permission select and a remove button on each row the owner manages, and block/unblock on every row but the
// viewer's own, whoever views it (mobile parity). Leaving stays the note menu's own entry. Every write is offline-
// disabled. Remounted per note (keyed by the host), so add mode and pending state never carry over.
function NoteParticipantsSurface({ note, className, ref, onKeyDown, onClose }: { note: Note } & DockedSurfaceProps) {
	const { t } = useTranslation(["notes", "common", "contacts"])
	const isOnline = useIsOnline()
	const accountQuery = useAccountQuery()
	const currentUserId = accountQuery.data?.id
	const owner = isNoteOwner(note, currentUserId)
	// Always enabled: the rows need the blocked set up front for their block/unblock control, and the add picker reads
	// the same query key warm.
	const contactsQuery = useContactsQuery({ enabled: true })
	const [mode, setMode] = useState<"list" | "add">("list")
	const [pending, setPending] = useState<PendingOperation | null>(null)
	const [removing, setRemoving] = useState<NoteParticipant | null>(null)
	// Block confirms first, as everywhere else it is offered (it also drops the contact); unblock does not.
	const [blocking, setBlocking] = useState<NoteParticipant | null>(null)
	// Leaving add mode unmounts the control that had focus; the Add button takes it back.
	const refocusAddButton = useRef(false)

	const rows = participantRows(note, currentUserId, owner, deriveBlockedUsers(contactsQuery.data?.blocked ?? []))
	const locked = pending !== null || !isOnline
	const offlineTitle = isOnline ? undefined : t("common:offlineActionDisabled")

	async function handlePermissionChange(participant: NoteParticipant, write: boolean): Promise<void> {
		setPending({ userId: participant.userId, write })
		const outcome = await setNoteParticipantPermission(note, participant, write)
		setPending(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	async function handleRemoveConfirmed(participant: NoteParticipant): Promise<void> {
		setPending({ userId: participant.userId })
		const outcome = await removeNoteParticipant(note, participant)
		setPending(null)
		setRemoving(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	async function handleToggleBlock(participant: NoteParticipant, isBlockedNow: boolean): Promise<void> {
		const toggled = toggleParticipantBlocked(participant, contactsQuery.data?.blocked, isBlockedNow)

		if (toggled === "stale") {
			toast.error(errorLabel(plainErrorDTO(t("common:participantBlockStale"))))

			return
		}

		setPending({ userId: participant.userId })
		const outcome = await toggled
		setPending(null)
		setBlocking(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	async function handleAdd(chosen: Contact[]): Promise<void> {
		const outcome = await addNoteParticipants(note, chosen)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))

			return
		}

		showList()
	}

	function showList(): void {
		setMode("list")
		refocusAddButton.current = true
	}

	function focusListView(element: HTMLDivElement | null): void {
		if (element !== null && refocusAddButton.current) {
			refocusAddButton.current = false
			document.getElementById(ADD_BUTTON_ID)?.focus()
		}
	}

	function renderRowControls({ participant, isSelf, canManage, blocked }: ParticipantRowModel, name: string) {
		// Only picks the row that shows the spinner; every row is locked while anything is pending.
		const rowPending = pending?.userId === participant.userId
		const write = rowPending && pending.write !== undefined ? pending.write : participant.permissionsWrite
		const permissionLabel = t(write ? "noteParticipantCanEdit" : "noteParticipantCanView")
		const blockButton = isSelf ? null : (
			<TooltipIconButton
				label={t(blocked ? "noteParticipantUnblockAction" : "noteParticipantBlockAction", { name })}
				disabled={locked}
				title={offlineTitle}
				onClick={() => {
					if (blocked) {
						void handleToggleBlock(participant, true)
					} else {
						setBlocking(participant)
					}
				}}
			>
				{rowPending && !canManage ? <Spinner /> : blocked ? <UserCheckIcon /> : <UserXIcon />}
			</TooltipIconButton>
		)

		if (participant.isOwner) {
			return (
				<>
					<span className="shrink-0 px-1 text-xs text-muted-foreground">{t("common:participantOwnerBadge")}</span>
					{blockButton}
				</>
			)
		}

		if (!canManage) {
			return (
				<>
					<span className="shrink-0 px-1 text-xs text-muted-foreground">{permissionLabel}</span>
					{blockButton}
				</>
			)
		}

		return (
			<>
				<Select
					items={PERMISSIONS.map(value => ({
						value,
						label: t(value === "edit" ? "noteParticipantCanEdit" : "noteParticipantCanView")
					}))}
					value={participantPermission(write)}
					disabled={locked}
					onValueChange={value => {
						if (value !== null && value !== participantPermission(participant.permissionsWrite)) {
							void handlePermissionChange(participant, value === "edit")
						}
					}}
				>
					<SelectTrigger
						size="sm"
						aria-label={t("noteParticipantPermissionLabel", { name })}
						title={offlineTitle}
						className="shrink-0 px-2 text-xs"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							{PERMISSIONS.map(value => (
								<SelectItem
									key={value}
									value={value}
								>
									{t(value === "edit" ? "noteParticipantCanEdit" : "noteParticipantCanView")}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
				<TooltipIconButton
					label={t("noteParticipantRemoveAction", { name })}
					disabled={locked}
					title={offlineTitle}
					onClick={() => {
						setRemoving(participant)
					}}
				>
					{rowPending ? <Spinner /> : <MinusIcon />}
				</TooltipIconButton>
				{blockButton}
			</>
		)
	}

	function renderListView() {
		return (
			<div
				ref={focusListView}
				className="flex min-h-0 flex-1 flex-col"
			>
				<p className="shrink-0 px-4 pb-3 text-xs text-muted-foreground">{t("noteParticipantsPanelDescription")}</p>
				<div className="mx-3 h-px shrink-0 bg-border/50" />
				<ul
					aria-labelledby={noteParticipantsPanel.titleId}
					className="flex min-h-0 flex-1 scrollbar-gutter-stable flex-col overflow-y-auto px-3 py-2"
				>
					{rows.map(row => {
						const name = contactDisplayName(row.participant)

						return (
							<li
								key={row.participant.userId.toString()}
								className="flex h-14 items-center gap-2 rounded-xl px-2 text-sm"
							>
								<UserAvatar
									src={row.participant.avatar}
									name={name}
								/>
								<div className="ml-1 min-w-0 flex-1">
									<p className="truncate font-medium">{row.isSelf ? t("noteParticipantSelf", { name }) : name}</p>
									<p className="truncate text-xs text-muted-foreground">{row.participant.email}</p>
								</div>
								{renderRowControls(row, name)}
							</li>
						)
					})}
				</ul>
			</div>
		)
	}

	return (
		<SidePanelSurface
			controller={noteParticipantsPanel}
			itemKey={note.uuid}
			title={t("noteParticipantsPanelTitle", { number: note.participants.length })}
			headerActions={
				owner && mode === "list" ? (
					<TooltipIconButton
						id={ADD_BUTTON_ID}
						label={t("common:participantsAddAction")}
						disabled={locked}
						title={offlineTitle}
						onClick={() => {
							setMode("add")
						}}
					>
						<PlusIcon />
					</TooltipIconButton>
				) : null
			}
			className={className}
			ref={ref}
			onKeyDown={onKeyDown}
			onClose={onClose}
		>
			{mode === "list" ? (
				renderListView()
			) : (
				<ParticipantsAddView
					contactsQuery={contactsQuery}
					exclude={note.participants}
					body={t("noteParticipantsAddDialogBody")}
					onAdd={handleAdd}
					onCancel={showList}
				/>
			)}
			<ConfirmDialog
				open={removing !== null}
				pending={pending !== null}
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
					if (removing !== null) {
						void handleRemoveConfirmed(removing)
					}
				}}
			/>
			<ConfirmDialog
				open={blocking !== null}
				pending={pending !== null}
				title={t("contacts:contactsBlockConfirmTitle")}
				body={t("contacts:contactsBlockConfirmBodySingle")}
				confirmLabel={t("contacts:contactsActionBlock")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					if (!open) {
						setBlocking(null)
					}
				}}
				onConfirm={() => {
					if (blocking !== null) {
						void handleToggleBlock(blocking, false)
					}
				}}
			/>
		</SidePanelSurface>
	)
}

// Mounted by the note editor pane for a readable, untrashed note (the menu offers Participants on no other). From the
// side panel breakpoint up the panel docks beside the note; below it the panel is a sheet from the right.
export function NoteParticipantsHost({ note }: { note: Note }) {
	const { t } = useTranslation("notes")

	return (
		<DockedSidePanel
			controller={noteParticipantsPanel}
			itemKey={note.uuid}
			label={t("noteActionParticipants")}
			renderSurface={surface => (
				<NoteParticipantsSurface
					key={note.uuid}
					note={note}
					{...surface}
				/>
			)}
		/>
	)
}
