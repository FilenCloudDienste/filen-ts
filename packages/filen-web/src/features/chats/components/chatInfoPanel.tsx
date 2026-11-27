import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { MoreHorizontalIcon, PencilIcon, PlusIcon, UserCheckIcon, UserMinusIcon, UsersIcon, UserXIcon, VolumeOffIcon } from "lucide-react"
import type { Chat, ChatParticipant, Contact } from "@filen/sdk-rs"
import { cn, contactDisplayName, type BlockedUsers } from "@filen/shared"
import { chatAvatarUrl, chatTitle, isChatUndecryptable } from "@/features/chats/lib/sort"
import { CHAT_ACTION_DEFS } from "@/features/chats/lib/actionDefs"
import { addChatParticipants, removeChatParticipant } from "@/features/chats/lib/participants"
import { runSetChatMuted } from "@/features/chats/lib/directActions"
import {
	chatInfoChatActions,
	chatInfoParticipantRows,
	participantPendingKey,
	participantRowActions,
	type ChatInfoParticipantRow
} from "@/features/chats/components/chatInfoPanel.logic"
import { useChatDialogHost } from "@/features/chats/hooks/useChatDialogHost"
import { isSidePanelNarrow, useIsSidePanelNarrow } from "@/features/shell/lib/sidePanelLayout"
import {
	CHAT_INFO_PANEL_ID,
	CHAT_INFO_TOGGLE_ID,
	chatInfoPanel,
	closeChatInfoDrawer,
	closeChatInfoPanel,
	openChatInfo,
	useChatInfoOpen
} from "@/features/chats/store/useChatInfoStore"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { toggleParticipantBlocked } from "@/features/contacts/lib/actions"
import { ParticipantsAddView } from "@/features/contacts/components/participantsAddView"
import { DockedSidePanel, SidePanelSurface, type DockedSurfaceProps } from "@/features/shell/components/dockedSidePanel"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { plainErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { Kbd } from "@/lib/keymap/kbd"
import { UserAvatar } from "@/components/userAvatar"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

const SECTION_HEADING_CLASS = "text-xs font-medium text-muted-foreground"

interface ChatInfoProps {
	chat: Chat
	currentUserId: bigint | undefined
	// The thread's own blocked set (one enabled read for the whole conversation view).
	blocked: BlockedUsers
}

function ParticipantRowMenu({
	row,
	pending,
	onRemove,
	onToggleBlock
}: {
	row: ChatInfoParticipantRow
	pending: boolean
	onRemove: (participant: ChatParticipant) => void
	onToggleBlock: (participant: ChatParticipant, isBlockedNow: boolean) => void
}) {
	const { t } = useTranslation(["chats", "common", "contacts"])
	const isOnline = useIsOnline()
	const actions = participantRowActions(row)
	const offlineTitle = isOnline ? undefined : t("common:offlineActionDisabled")

	if (actions.length === 0) {
		return null
	}

	if (pending) {
		return (
			<span className="flex size-7 shrink-0 items-center justify-center">
				<Spinner />
			</span>
		)
	}

	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger
					render={
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={t("chatInfoParticipantMenu", { name: contactDisplayName(row.participant) })}
								>
									<MoreHorizontalIcon />
								</Button>
							}
						/>
					}
				/>
				<TooltipContent>{t("chatInfoParticipantMenu", { name: contactDisplayName(row.participant) })}</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="end">
				{actions.map(action => {
					switch (action) {
						case "remove":
							return (
								<DropdownMenuItem
									key={action}
									variant="destructive"
									disabled={!isOnline}
									title={offlineTitle}
									onClick={() => {
										onRemove(row.participant)
									}}
								>
									<UserMinusIcon aria-hidden="true" />
									{t("common:participantRemoveDialogConfirm")}
								</DropdownMenuItem>
							)
						case "block":
						case "unblock":
							return (
								<DropdownMenuItem
									key={action}
									disabled={!isOnline}
									title={offlineTitle}
									onClick={() => {
										onToggleBlock(row.participant, row.blocked)
									}}
								>
									{action === "block" ? <UserXIcon aria-hidden="true" /> : <UserCheckIcon aria-hidden="true" />}
									{t(action === "block" ? "contacts:contactsActionBlock" : "contacts:contactsActionUnblock")}
								</DropdownMenuItem>
							)
					}
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// The conversation's details and management: its name (rename for the owner), mute, the participants with their
// per-row actions (remove for the owner, block/unblock for anyone), adding participants from contacts (owner), and
// Leave or Delete. Every write is offline-disabled, as the chat menu's are. Remounted per conversation (keyed by the
// host), so add mode and pending state never carry over.
function ChatInfoSurface({ chat, currentUserId, blocked, className, ref, onKeyDown, onClose }: ChatInfoProps & DockedSurfaceProps) {
	const { t } = useTranslation(["chats", "common", "contacts"])
	const isOnline = useIsOnline()
	// The thread's own dialog host is outside the sheet; one rendered in here keeps rename/leave/delete nested in it.
	const dialogHost = useChatDialogHost()
	// Shares the thread's query key (useBlockedUsers): the blocked records the unblock needs and the add picker's
	// contacts, no request of its own.
	const contactsQuery = useContactsQuery({ enabled: true })
	const [mode, setMode] = useState<"list" | "add">("list")
	// One entry per running write, by action and participant (participantPendingKey), so a block settling never ends a
	// removal's spinner or its confirm's, nor the other way round.
	const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
	const [removing, setRemoving] = useState<ChatParticipant | null>(null)
	// Block confirms first, as everywhere else it is offered (it also drops the contact); unblock does not.
	const [blocking, setBlocking] = useState<ChatParticipant | null>(null)
	// Leaving add mode unmounts the control that had focus; the Add button takes it back.
	const refocusAddButton = useRef(false)

	const title = chatTitle(chat, currentUserId, t("chatUndecryptable"), t("chatJustYou"))
	const rows = chatInfoParticipantRows(chat, currentUserId, blocked)
	const { rename, mute, end } = chatInfoChatActions(chat, currentUserId, isOnline)
	const owner = end?.id === "delete"
	const offlineTitle = isOnline ? undefined : t("common:offlineActionDisabled")

	function showList(): void {
		setMode("list")
		refocusAddButton.current = true
	}

	function setActionPending(key: string, running: boolean): void {
		setPending(prev => {
			const next = new Set(prev)

			if (running) {
				next.add(key)
			} else {
				next.delete(key)
			}

			return next
		})
	}

	async function handleRemoveConfirmed(participant: ChatParticipant): Promise<void> {
		const key = participantPendingKey("remove", participant.userId)

		setActionPending(key, true)
		const outcome = await removeChatParticipant(chat, participant)
		setActionPending(key, false)
		setRemoving(current => (current?.userId === participant.userId ? null : current))

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	async function handleToggleBlock(participant: ChatParticipant, isBlockedNow: boolean): Promise<void> {
		const toggled = toggleParticipantBlocked(participant, contactsQuery.data?.blocked, isBlockedNow)

		if (toggled === "stale") {
			toast.error(errorLabel(plainErrorDTO(t("common:participantBlockStale"))))

			return
		}

		const key = participantPendingKey("block", participant.userId)

		setActionPending(key, true)
		const outcome = await toggled
		setActionPending(key, false)
		setBlocking(current => (current?.userId === participant.userId ? null : current))

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	async function handleAdd(chosen: Contact[]): Promise<void> {
		const outcome = await addChatParticipants(chat, chosen)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))

			return
		}

		showList()
	}

	function focusAddButton(element: HTMLButtonElement | null): void {
		if (element !== null && refocusAddButton.current) {
			refocusAddButton.current = false
			element.focus()
		}
	}

	function renderRow(row: ChatInfoParticipantRow) {
		const { participant } = row
		const name = row.isSelf ? t("chatSenderYou") : contactDisplayName(participant)

		return (
			<li
				key={participant.userId.toString()}
				className="flex h-14 items-center gap-3 rounded-xl px-2 text-sm"
			>
				<UserAvatar
					src={participant.avatar}
					name={contactDisplayName(participant)}
				/>
				<div className="min-w-0 flex-1">
					<p className="truncate font-medium">
						{name}
						{row.blocked ? (
							<span className="font-normal text-muted-foreground"> · {t("chatParticipantBlockedMarker")}</span>
						) : null}
					</p>
					<p className="truncate text-xs text-muted-foreground">{participant.email}</p>
				</div>
				{row.isOwner ? <span className="shrink-0 text-xs text-muted-foreground">{t("common:participantOwnerBadge")}</span> : null}
				<ParticipantRowMenu
					row={row}
					pending={
						pending.has(participantPendingKey("remove", participant.userId)) ||
						pending.has(participantPendingKey("block", participant.userId))
					}
					onRemove={setRemoving}
					onToggleBlock={(target, isBlockedNow) => {
						if (isBlockedNow) {
							void handleToggleBlock(target, true)
						} else {
							setBlocking(target)
						}
					}}
				/>
			</li>
		)
	}

	function renderListView() {
		return (
			<div className="flex min-h-0 flex-1 scrollbar-gutter-stable flex-col overflow-y-auto px-3 pb-3">
				<div className="flex flex-col items-center gap-1 px-2 pt-2 pb-4 text-center">
					<UserAvatar
						src={chatAvatarUrl(chat, currentUserId)}
						name={title}
						className="mb-2 size-16"
						fallbackClassName="text-xl"
					/>
					<div className="flex max-w-full items-center gap-1">
						<p className="min-w-0 truncate text-base font-semibold">{title}</p>
						{rename?.run === "dialog" ? (
							<TooltipIconButton
								label={t(rename.labelKey)}
								disabled={rename.enabled === false}
								title={offlineTitle}
								onClick={() => {
									dialogHost.openChatDialog(rename.dialogKind, chat)
								}}
							>
								<PencilIcon />
							</TooltipIconButton>
						) : null}
					</div>
					<p className="text-xs text-muted-foreground">{t("chatHeaderParticipants", { count: chat.participants.length })}</p>
				</div>
				{mute === undefined ? null : (
					<label
						title={offlineTitle}
						className={cn(
							"flex items-center gap-3 rounded-xl px-2 py-2.5 text-sm",
							mute.enabled === false ? "text-muted-foreground" : "hover:bg-accent/50"
						)}
					>
						<VolumeOffIcon
							aria-hidden="true"
							className="size-4 shrink-0 text-muted-foreground"
						/>
						<span className="min-w-0 flex-1">{t("chatInfoMute")}</span>
						<Switch
							checked={chat.muted}
							disabled={mute.enabled === false}
							onCheckedChange={checked => {
								runSetChatMuted(chat, checked)
							}}
						/>
					</label>
				)}
				<div className="mt-3 flex h-8 items-center justify-between px-2">
					<h3
						id={`${CHAT_INFO_PANEL_ID}-participants`}
						className={SECTION_HEADING_CLASS}
					>
						{t("common:participantsDialogTitle")}
					</h3>
					{owner ? (
						<Button
							ref={focusAddButton}
							variant="ghost"
							size="xs"
							aria-label={t("common:participantsAddAction")}
							disabled={!isOnline}
							title={offlineTitle}
							onClick={() => {
								setMode("add")
							}}
						>
							<PlusIcon data-icon="inline-start" />
							{t("common:participantsAddSubmit")}
						</Button>
					) : null}
				</div>
				<ul
					aria-labelledby={`${CHAT_INFO_PANEL_ID}-participants`}
					className="flex flex-col"
				>
					{rows.map(renderRow)}
				</ul>
				{end?.run === "dialog" ? (
					<>
						<div className="mx-2 my-3 h-px shrink-0 bg-border/50" />
						<Button
							variant="ghost"
							className="justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
							disabled={end.enabled === false}
							title={offlineTitle}
							onClick={() => {
								dialogHost.openChatDialog(end.dialogKind, chat)
							}}
						>
							<end.icon data-icon="inline-start" />
							{t(end.labelKey)}
						</Button>
					</>
				) : null}
			</div>
		)
	}

	return (
		<SidePanelSurface
			controller={chatInfoPanel}
			itemKey={chat.uuid}
			title={t("chatInfoTitle")}
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
					exclude={chat.participants}
					body={t("chatParticipantsAddDialogBody")}
					onAdd={handleAdd}
					onCancel={showList}
				/>
			)}
			<ConfirmDialog
				open={removing !== null}
				pending={removing !== null && pending.has(participantPendingKey("remove", removing.userId))}
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
					if (removing !== null) {
						void handleRemoveConfirmed(removing)
					}
				}}
			/>
			<ConfirmDialog
				open={blocking !== null}
				pending={blocking !== null && pending.has(participantPendingKey("block", blocking.userId))}
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
			{dialogHost.renderActiveDialog()}
		</SidePanelSurface>
	)
}

// Mounted by the thread. From the side panel breakpoint up the panel is portalled into the shell's side-panel slot,
// beside the content card; below it the panel is a sheet from the right. Either mounts only while open, and never for
// an undecryptable conversation (the menu offers only Leave/Delete there).
export function ChatInfoHost(props: ChatInfoProps) {
	const { t } = useTranslation("chats")

	if (isChatUndecryptable(props.chat)) {
		return null
	}

	return (
		<DockedSidePanel
			controller={chatInfoPanel}
			itemKey={props.chat.uuid}
			label={t("chatInfoTitle")}
			renderSurface={surface => (
				<ChatInfoSurface
					key={props.chat.uuid}
					{...props}
					{...surface}
				/>
			)}
		/>
	)
}

// The thread header's toggle; offered wherever the panel can open (not for an undecryptable conversation). Opening
// it writes nothing, so it stays enabled offline; the writes inside are gated one by one.
export function ChatInfoToggle({ chat }: { chat: Chat }) {
	const { t } = useTranslation("chats")
	const narrow = useIsSidePanelNarrow()
	const open = useChatInfoOpen(chat.uuid, narrow)
	const label = t(CHAT_ACTION_DEFS.participants.labelKey)

	if (isChatUndecryptable(chat)) {
		return null
	}

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						id={CHAT_INFO_TOGGLE_ID}
						variant="ghost"
						size="icon-sm"
						aria-label={label}
						aria-expanded={open}
						aria-controls={open ? CHAT_INFO_PANEL_ID : undefined}
						onClick={() => {
							if (!open) {
								openChatInfo(chat.uuid)
							} else if (isSidePanelNarrow()) {
								closeChatInfoDrawer()
							} else {
								closeChatInfoPanel()
							}
						}}
					>
						<UsersIcon />
					</Button>
				}
			/>
			<TooltipContent>
				{label}
				<Kbd action="chats.participants" />
			</TooltipContent>
		</Tooltip>
	)
}
