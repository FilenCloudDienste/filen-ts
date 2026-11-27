import { useEffect, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CornerUpLeftIcon, ClockIcon, AlertCircleIcon, BanIcon } from "lucide-react"
import type { Chat, ChatMessage, ChatMessagePartial } from "@filen/sdk-rs"
import { cn, segmentMessage, type BlockedUsers } from "@filen/shared"
import { messageSenderName } from "@/features/chats/lib/sort"
import { isOwnMessage, isSenderBlocked } from "@/features/chats/lib/sender"
import { useRevealedBlockedMessages } from "@/features/chats/store/useRevealedBlockedMessages"
import { formatClockTime } from "@/features/chats/lib/time"
import { deleteMessage } from "@/features/chats/lib/messageActions"
import { dayTimeLabel } from "@/features/chats/components/thread/timeLabel"
import { MessageContextMenuContent } from "@/features/chats/components/thread/messageMenu"
import { MessageActionBar } from "@/features/chats/components/thread/messageActionBar"
import { useMessageActions, type MessageActionsHandle } from "@/features/chats/components/thread/useMessageActions"
import { MessageContent } from "@/features/chats/components/thread/messageContent"
import { MessageEmbeds } from "@/features/chats/components/thread/messageEmbeds"
import { linksFromSegments, embedCandidatesForLinks } from "@/features/chats/lib/embeds.logic"
import { messageAddressing } from "@/features/chats/lib/mentions.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { safeAvatarUrl } from "@/lib/avatarUrl"
import { useChatSendState } from "@/features/chats/store/useChatsInflight"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { UserAvatar } from "@/components/userAvatar"
import { useTouchLongPress } from "@/lib/useTouchLongPress"

// Compact reply reference above a reply's line: the quoted sender + a one-line snippet of the referenced
// message (denormalized snapshot on message.replyTo). Undecryptable reference bodies (message undefined)
// render nothing but the sender, matching the message body's own undecryptable handling.
//
// A reference to a BLOCKED sender is fully redacted: the row's own sender is not blocked, so the
// tombstone below never covers it, and rendering it verbatim would republish exactly the name and text the
// tombstone/preview withhold. The arrow and geometry stay (the reader still needs to know this is a
// reply); the name and the snippet both go. No reveal affordance here — this is a denormalized snapshot,
// and the referenced message itself is revealable in place if still in the thread.
function ReplyReference({
	replyTo,
	blocked,
	currentUserId
}: {
	replyTo: ChatMessagePartial
	blocked: BlockedUsers
	currentUserId: bigint | undefined
}) {
	const { t } = useTranslation("chats")
	const senderBlocked = isSenderBlocked(replyTo, blocked)

	return (
		<div
			data-slot="reply-reference"
			className="flex max-w-full min-w-0 items-center gap-1 pb-0.5 text-xs leading-4 text-muted-foreground"
		>
			<CornerUpLeftIcon
				aria-hidden="true"
				className="size-3 shrink-0"
			/>
			{senderBlocked ? (
				<span className="min-w-0 truncate italic">{t("chatMessageHiddenBlocked")}</span>
			) : (
				<>
					<span className="shrink-0 font-medium">
						{t("chatReplyReferenceSender", {
							name: isOwnMessage(replyTo, currentUserId) ? t("chatSenderYou") : messageSenderName(replyTo)
						})}
					</span>
					{replyTo.message !== undefined && replyTo.message.length > 0 ? (
						<span className="min-w-0 truncate">{replyTo.message}</span>
					) : null}
				</>
			)}
		</div>
	)
}

export interface MessageRowProps {
	chat: Chat
	message: ChatMessage
	// The run's oldest row (thread.logic.ts): it opens with the avatar, the sender's name and the time.
	runStart: boolean
	currentUserId: bigint | undefined
	// The signed-in account's avatar, for own runs.
	ownAvatarUrl: string | undefined
	// From the thread's single enabled read (messageThread.tsx).
	blocked: BlockedUsers
	// The thread's roving message: its focus target is the thread's one Tab stop among the messages.
	active: boolean
	// Set on the active row only: where it publishes its actions for the thread's keyboard commands.
	actionsRef: RefObject<MessageActionsHandle | null> | null
	// The composer is replying to this message (derived once by the thread from the composer store).
	replying: boolean
}

// The hover highlight, also held while the row's context menu (its own data-popup-open) or its action bar's ⋯ menu (a
// descendant's) is open: CSS reads Base UI's trigger state, so no row keeps menu state of its own. A failed send keeps
// its error tint, deepened the same way.
const ROW_HIGHLIGHT = "hover:bg-muted data-popup-open:bg-muted has-[[data-popup-open]]:bg-muted"
const FAILED_ROW_HIGHLIGHT =
	"bg-destructive/6 hover:bg-destructive/10 data-popup-open:bg-destructive/10 has-[[data-popup-open]]:bg-destructive/10"
// A message addressed to the reader (an @mention of them or @everyone, or a reply to them): a faint accent tint and a
// thin accent bar on the leading edge, deepened on hover like the others. The reason is also spoken (sr-only), so the
// tint is never the only signal.
const ADDRESSED_ROW_HIGHLIGHT =
	"bg-chat-own/8 before:pointer-events-none before:absolute before:inset-y-0 before:start-0 before:w-0.5 before:bg-chat-own hover:bg-chat-own/14 data-popup-open:bg-chat-own/14 has-[[data-popup-open]]:bg-chat-own/14"

// One message as a full-width row, everyone's left-aligned: a run opens with the avatar in the gutter and
// the name and time on the first line, and each later line sits under the name with its time in the gutter
// on hover. The text column is capped so wide panes never set long lines; the row itself spans the pane for the
// hover highlight, which a row also wears while the composer replies to it or one of its menus is open. The hover action bar (MessageActionBar)
// floats over the row's top-right corner. There is no deleted tombstone: the wasm ChatMessage has no
// deleted flag — deletions remove the message outright (socketHandlers.ts's messageDelete handler drops it
// from the cache), so the special body states here are undecryptable (message === undefined → placeholder)
// and a blocked sender's tap-to-reveal tombstone. The row carries its own right-click menu; the delete
// confirm dialog is owned HERE (not the menu content) so it survives past the menu's own close.
export function MessageRow({
	chat,
	message,
	runStart,
	currentUserId,
	ownAvatarUrl,
	blocked,
	active,
	actionsRef,
	replying
}: MessageRowProps) {
	const { t } = useTranslation(["chats", "common"])
	const undecryptable = message.message === undefined
	const own = isOwnMessage(message, currentUserId)
	const name = messageSenderName(message)
	const senderBlocked = isSenderBlocked(message, blocked)
	const revealed = useRevealedBlockedMessages(state => state.revealed.has(message.uuid))
	const showTombstone = senderBlocked && !revealed
	// The optimistic copy's uuid IS its inflightId, so this read resolves an in-flight/failed own message
	// to "pending"/"failed" and every confirmed (real-uuid) message to "confirmed".
	const sendState = useChatSendState(message.uuid)
	const sending = sendState === "pending" || sendState === "sending"
	const failed = sendState === "failed"
	// Tokenized once for both the body and the embeds. Pure/sync (no query), so the menu's "Disable embed"
	// entry is gated without waiting on the async resolution MessageEmbeds itself triggers.
	const segments = segmentMessage(message.message)
	const embedCandidates = message.embedDisabled ? [] : embedCandidatesForLinks(linksFromSegments(segments))
	const hasEmbeds = embedCandidates.length > 0
	const addressing = messageAddressing(message, segments, chat.participants, currentUserId)

	const [confirmingDelete, setConfirmingDelete] = useState(false)
	const [deletePending, setDeletePending] = useState(false)

	function requestDelete(): void {
		setConfirmingDelete(true)
	}

	async function handleDeleteConfirmed(): Promise<void> {
		setDeletePending(true)
		const outcome = await deleteMessage(chat, message)
		setDeletePending(false)
		setConfirmingDelete(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	// One action model per row, shared by the hover bar, its overflow and the right-click menu: their
	// bodies render with every menu closed, so a call in each would triple the subscriptions per row.
	const actions = useMessageActions({
		chat,
		message,
		currentUserId,
		sendState,
		hasEmbeds,
		blocked,
		onRequestDelete: requestDelete
	})

	// The action bar's ⋯ menu, also opened by a touch long-press on the row: the bar shows on hover and focus only, which
	// a touch never gives. It replaces the context menu's own long-press, so a touch opens one menu, at the bar.
	const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
	const press = useTouchLongPress<HTMLDivElement>({
		onLongPress: () => {
			if (actions.descriptors.length > 0) {
				setActionsMenuOpen(true)
			}
		}
	})

	// The active row hands the thread its action model for the message keys (keymap.ts chats.message.*), so the keys
	// and the menus share one set of gates. A hidden blocked message offers none, as its menu does.
	useEffect(() => {
		if (actionsRef === null || showTombstone) {
			return
		}

		actionsRef.current = actions

		return () => {
			if (actionsRef.current === actions) {
				actionsRef.current = null
			}
		}
	})

	// The run gap sits outside the highlighted row, so the highlight covers the message only.
	const gapClassName = runStart ? "pt-3" : undefined
	const sentLabel = runStart ? dayTimeLabel(t, message.sentTimestamp) : undefined

	// Placed after every hook above (including the two useStates) — an earlier return would change hook
	// order the moment "Show" flips this to false on a mounted row. Replaces the whole ContextMenu subtree:
	// no avatar, no sender name, no reply reference, no body, no embeds, no send state, no action bar and
	// no menu — a blocked sender's row offers nothing but the reveal.
	if (showTombstone) {
		return (
			<div className={gapClassName}>
				<div className="flex gap-4 px-4 py-px">
					<div className="w-10 shrink-0" />
					<button
						type="button"
						data-message-focus=""
						tabIndex={active ? 0 : -1}
						onClick={() => {
							useRevealedBlockedMessages.getState().reveal(message.uuid)
						}}
						className="flex min-w-0 items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-[5px] text-xs leading-5 focus-ring outline-none"
					>
						<BanIcon
							aria-hidden="true"
							className="size-3.5 shrink-0 text-muted-foreground"
						/>
						<span className="text-muted-foreground italic">{t("chatMessageHiddenBlocked")}</span>
						<span className="font-medium text-foreground">{t("chatMessageHiddenBlockedShow")}</span>
					</button>
				</div>
			</div>
		)
	}

	return (
		<>
			<div className={gapClassName}>
				<ContextMenu>
					<ContextMenuTrigger
						render={
							// The message's keyboard focus target: ↑/↓ move between messages, and the message keys act on
							// the focused one (messageThread.tsx). One roving Tab stop for the whole thread.
							<div
								data-message-focus=""
								tabIndex={active ? 0 : -1}
								{...press.handlers}
								className={cn(
									"group relative px-4 py-px focus-ring-row outline-none focus-visible:ring-inset",
									failed ? FAILED_ROW_HIGHLIGHT : addressing !== null ? ADDRESSED_ROW_HIGHLIGHT : ROW_HIGHLIGHT,
									replying && (failed ? "bg-destructive/10" : addressing !== null ? "bg-chat-own/14" : "bg-muted")
								)}
							>
								{message.replyTo !== undefined ? (
									<div className="ml-14 max-w-[760px]">
										<ReplyReference
											replyTo={message.replyTo}
											blocked={blocked}
											currentUserId={currentUserId}
										/>
									</div>
								) : null}
								<div className="flex gap-4">
									<div className="w-10 shrink-0">
										{runStart ? (
											<UserAvatar
												// Own runs show the account's current picture: a message's sender avatar is a
												// snapshot from when it was sent.
												src={safeAvatarUrl(own ? ownAvatarUrl : message.senderAvatar)}
												name={name}
												size="lg"
											/>
										) : (
											// Kept on a coarse pointer, where hover never reveals it.
											<span className="block text-right text-[11px] leading-5 whitespace-nowrap text-muted-foreground tabular-nums opacity-0 select-none group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
												{formatClockTime(message.sentTimestamp)}
											</span>
										)}
									</div>
									<div className="flex max-w-[760px] min-w-0 flex-1 flex-col">
										{runStart ? (
											<div className="flex min-w-0 items-baseline gap-2">
												<span className="min-w-0 truncate text-sm leading-5 font-medium">
													{own ? t("chatSenderYou") : name}
												</span>
												{/* Every day opens with a divider naming it (thread.logic.ts), so the run's line
												    shows the clock only; the full date is its hover title and spoken label. */}
												<time
													dateTime={new Date(Number(message.sentTimestamp)).toISOString()}
													title={sentLabel}
													className="shrink-0 text-xs text-muted-foreground tabular-nums"
												>
													<span aria-hidden="true">{formatClockTime(message.sentTimestamp)}</span>
													<span className="sr-only">{sentLabel}</span>
												</time>
											</div>
										) : null}
										{addressing !== null ? (
											<span className="sr-only select-none">
												{addressing === "mention" ? t("chatMessageMentionsYou") : t("chatMessageRepliesToYou")}
											</span>
										) : null}
										<div className={cn("min-w-0 text-sm leading-5 select-text", sending && "opacity-60")}>
											{undecryptable ? (
												<span className="text-muted-foreground italic">{t("chatMessageUndecryptable")}</span>
											) : (
												<MessageContent
													participants={chat.participants}
													segments={segments}
												/>
											)}
											{!undecryptable && message.edited ? (
												<span className="ml-1.5 text-[11px] text-muted-foreground select-none">
													{t("chatMessageEdited")}
												</span>
											) : null}
										</div>
										{hasEmbeds ? <MessageEmbeds candidates={embedCandidates} /> : null}
										{sending ? (
											<span className="flex items-center gap-1 pt-0.5 text-[11px] leading-4 text-muted-foreground">
												<ClockIcon
													aria-hidden="true"
													className="size-3 shrink-0"
												/>
												{t("chatMessageSending")}
											</span>
										) : null}
										{failed ? (
											<span className="flex items-center gap-1 pt-0.5 text-[11px] leading-4 text-destructive">
												<AlertCircleIcon
													aria-hidden="true"
													className="size-3 shrink-0"
												/>
												{t("chatMessageFailed")}
											</span>
										) : null}
									</div>
								</div>
								{/* Over the row's top edge, out of flow so it adds no height. Only the bar itself is
								    hit-testable, and only while revealed. */}
								<div className="pointer-events-none absolute -top-4 right-4 z-10">
									<MessageActionBar
										{...actions}
										menuOpen={actionsMenuOpen}
										onMenuOpenChange={setActionsMenuOpen}
									/>
								</div>
							</div>
						}
					/>
					<MessageContextMenuContent {...actions} />
				</ContextMenu>
			</div>
			<ConfirmDialog
				open={confirmingDelete}
				pending={deletePending}
				title={t("chatMessageDeleteDialogTitle")}
				body={t("chatMessageDeleteDialogBody")}
				confirmLabel={t("chatMessageActionDelete")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					if (!open) {
						setConfirmingDelete(false)
					}
				}}
				onConfirm={() => {
					void handleDeleteConfirmed()
				}}
			/>
		</>
	)
}
