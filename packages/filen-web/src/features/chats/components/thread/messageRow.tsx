import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CornerUpLeftIcon, ClockIcon, AlertCircleIcon, BanIcon } from "lucide-react"
import type { Chat, ChatMessage, ChatMessagePartial } from "@filen/sdk-rs"
import { cn, isEmojiOnly, segmentMessage, type BlockedUsers } from "@filen/shared"
import { messageSenderName } from "@/features/chats/lib/sort"
import { isOwnMessage, isSenderBlocked } from "@/features/chats/lib/sender"
import { useRevealedBlockedMessages } from "@/features/chats/store/useRevealedBlockedMessages"
import { formatClockTime } from "@/features/chats/lib/time"
import { deleteMessage } from "@/features/chats/lib/messageActions"
import { showsSenderName } from "@/features/chats/components/thread/thread.logic"
import { MessageContextMenuContent } from "@/features/chats/components/thread/messageMenu"
import { MessageActionBar } from "@/features/chats/components/thread/messageActionBar"
import { useMessageActions } from "@/features/chats/components/thread/useMessageActions"
import { MessageContent } from "@/features/chats/components/thread/messageContent"
import { MessageEmbeds } from "@/features/chats/components/thread/messageEmbeds"
import { linksFromSegments, embedCandidatesForLinks } from "@/features/chats/lib/embeds.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { safeAvatarUrl } from "@/lib/avatarUrl"
import { useChatSendState } from "@/features/chats/store/useChatsInflight"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { UserAvatar } from "@/components/userAvatar"

// The tail on a run's newest bubble, hooked out of its bottom corner on the sender's side. Absolute, so it
// adds no height to the row; the bubble's own corner on that side is squared off for it to attach to.
// `className` sets its side and its colour (it fills with currentColor).
export function BubbleTail({ className }: { className: string }) {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 14 18"
			className={cn("pointer-events-none absolute bottom-0 h-[18px] w-3.5 fill-current", className)}
		>
			<path d="M8 0C8 9 10 15 14 18C9 18.5 3 17.5 0 14V0Z" />
		</svg>
	)
}

// Tail placement per side: the svg overlaps the bubble's squared corner by 6px and hooks outward; the
// left-side tail is the right one mirrored.
export const OWN_TAIL_CLASS = "-right-1.5"
export const OTHER_TAIL_CLASS = "-left-1.5 -scale-x-100"

// Compact reply reference above a reply's bubble — the quoted sender + a one-line snippet of the referenced
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
			className="mb-0.5 flex max-w-full min-w-0 items-center gap-1 rounded-xl bg-muted px-2.5 py-1 text-xs text-muted-foreground"
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
	// The row's place in its run (thread.logic.ts): the oldest bubble carries a group chat's sender name,
	// the newest carries the tail and a group chat's avatar.
	runStart: boolean
	runEnd: boolean
	// More than two participants: other people's runs are named and pictured.
	group: boolean
	currentUserId: bigint | undefined
	// From the thread's single enabled read (messageThread.tsx).
	blocked: BlockedUsers
}

// One message as a bubble: own messages right-aligned in the brand colour, everyone else's left-aligned on
// a neutral surface. Beside the bubble, on its inner side, the hover action bar (MessageActionBar) and the
// exact send time appear on hover/focus. There is no deleted tombstone: the wasm ChatMessage has no deleted
// flag — deletions remove the message outright (socketHandlers.ts's messageDelete handler drops it from the
// cache), so the special body states here are undecryptable (message === undefined → placeholder) and a
// blocked sender's tap-to-reveal tombstone. The bubble column carries its own right-click menu; the delete
// confirm dialog is owned HERE (not the menu content) so it survives past the menu's own close.
export function MessageRow({ chat, message, runStart, runEnd, group, currentUserId, blocked }: MessageRowProps) {
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
	// Emoji-only messages render large and bare, with no bubble behind them.
	const bare = !undecryptable && isEmojiOnly(segments)
	// Other people's rows in a group keep the avatar column so their bubbles line up; only a run's newest
	// bubble fills it.
	const avatarColumn = group && !own

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

	const rowClassName = cn("flex w-full items-end gap-2 px-4", runStart ? "pt-2.5" : "pt-0.5", own && "justify-end")

	// Placed after every hook above (including the two useStates) — an earlier return would change hook
	// order the moment "Show" flips this to false on a mounted row. Replaces the whole ContextMenu subtree:
	// no avatar, no sender name, no reply reference, no body, no embeds, no send state, no action bar and
	// no menu — a blocked sender's row offers nothing but the reveal. The dashed pill keeps a one-line
	// bubble's height, so the row's height estimate still holds.
	if (showTombstone) {
		return (
			<div className={rowClassName}>
				{avatarColumn ? <div className="w-7 shrink-0" /> : null}
				<button
					type="button"
					onClick={() => {
						useRevealedBlockedMessages.getState().reveal(message.uuid)
					}}
					className="flex min-w-0 items-center gap-1.5 rounded-[18px] border border-dashed border-border px-3 py-[5px] text-xs leading-5 focus-ring outline-none"
				>
					<BanIcon
						aria-hidden="true"
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
					<span className="text-muted-foreground italic">{t("chatMessageHiddenBlocked")}</span>
					<span className="font-medium text-foreground">{t("chatMessageHiddenBlockedShow")}</span>
				</button>
			</div>
		)
	}

	return (
		<>
			<div className={rowClassName}>
				{avatarColumn ? (
					<div className="w-7 shrink-0">
						{runEnd ? (
							<UserAvatar
								src={safeAvatarUrl(message.senderAvatar)}
								name={name}
								className="size-7"
							/>
						) : null}
					</div>
				) : null}
				<ContextMenu>
					<ContextMenuTrigger
						render={
							<div className={cn("group relative flex max-w-[70%] min-w-0 flex-col", own ? "items-end" : "items-start")}>
								{showsSenderName(runStart, own, group) ? (
									<span className="max-w-full truncate px-3 pb-0.5 text-xs text-muted-foreground">{name}</span>
								) : null}
								{message.replyTo !== undefined ? (
									<ReplyReference
										replyTo={message.replyTo}
										blocked={blocked}
										currentUserId={currentUserId}
									/>
								) : null}
								<div className="relative flex max-w-full min-w-0">
									<div
										className={cn(
											"relative min-w-0 text-sm select-text",
											bare
												? "py-0.5"
												: [
														"rounded-[18px] px-3 py-1.5",
														failed
															? "bg-destructive text-primary-foreground"
															: own
																? "bg-chat-own text-chat-own-foreground"
																: "bg-chat-other text-foreground",
														runEnd && (own ? "rounded-br-[6px]" : "rounded-bl-[6px]")
													],
											sending && "opacity-60"
										)}
									>
										{undecryptable ? (
											<span className="italic opacity-80">{t("chatMessageUndecryptable")}</span>
										) : (
											<MessageContent
												participants={chat.participants}
												segments={segments}
												own={own}
											/>
										)}
										{runEnd && !bare ? (
											<BubbleTail
												className={cn(
													own ? OWN_TAIL_CLASS : OTHER_TAIL_CLASS,
													failed ? "text-destructive" : own ? "text-chat-own" : "text-chat-other"
												)}
											/>
										) : null}
									</div>
									{/* Beside the bubble on its inner side, out of flow so it adds no height. Only
									    hit-testable while revealed, and then including its gap to the bubble, so the
									    pointer can cross to the bar without leaving the hover group. The time stays
									    visible on a coarse pointer, where hover never reveals it. */}
									<div
										className={cn(
											"pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 select-none group-focus-within:pointer-events-auto group-hover:pointer-events-auto",
											own ? "right-full flex-row-reverse pr-1.5" : "left-full pl-1.5"
										)}
									>
										<MessageActionBar {...actions} />
										<span className="text-[11px] leading-4 whitespace-nowrap text-muted-foreground tabular-nums opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
											{formatClockTime(message.sentTimestamp)}
										</span>
									</div>
								</div>
								{!undecryptable && message.edited ? (
									<span className="px-3 pt-0.5 text-[11px] leading-4 text-muted-foreground">
										{t("chatMessageEdited")}
									</span>
								) : null}
								{hasEmbeds ? <MessageEmbeds candidates={embedCandidates} /> : null}
								{sending ? (
									<span className="flex items-center gap-1 px-3 pt-0.5 text-[11px] leading-4 text-muted-foreground">
										<ClockIcon
											aria-hidden="true"
											className="size-3 shrink-0"
										/>
										{t("chatMessageSending")}
									</span>
								) : null}
								{failed ? (
									<span className="flex items-center gap-1 px-3 pt-0.5 text-[11px] leading-4 text-destructive">
										<AlertCircleIcon
											aria-hidden="true"
											className="size-3 shrink-0"
										/>
										{t("chatMessageFailed")}
									</span>
								) : null}
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
