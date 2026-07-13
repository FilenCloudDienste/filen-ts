import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CornerUpRightIcon, ClockIcon, AlertCircleIcon } from "lucide-react"
import type { Chat, ChatMessage, ChatMessagePartial } from "@filen/sdk-rs"
import { cn } from "@/lib/utils"
import { formatClockTime } from "@/features/chats/lib/time"
import { senderNameColor } from "@/features/chats/lib/nameColor"
import { deleteMessage } from "@/features/chats/lib/messageActions"
import { MessageContextMenuContent } from "@/features/chats/components/thread/messageMenu"
import { MessageActionBar } from "@/features/chats/components/thread/messageActionBar"
import { MessageContent } from "@/features/chats/components/thread/messageContent"
import { MessageEmbeds } from "@/features/chats/components/thread/messageEmbeds"
import { extractMessageLinks, embedCandidatesForLinks } from "@/features/chats/lib/embeds.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useChatSendState } from "@/features/chats/store/useChatsInflight"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

// Sender display name for a message, from its denormalized sender fields (nickname wins over email),
// mirroring contactDisplayName. Message sender fields ride on the message itself, not a participant lookup,
// so a sender who has since left the conversation still renders correctly.
function senderName(message: ChatMessagePartial): string {
	return message.senderNickName !== undefined && message.senderNickName.length > 0 ? message.senderNickName : message.senderEmail
}

// Compact reply-to reference line above a reply — the quoted sender + a one-line snippet of the referenced
// message (denormalized snapshot on message.replyTo). Undecryptable reference bodies (message undefined)
// render nothing but the sender, matching the message body's own undecryptable handling.
function ReplyReference({ replyTo }: { replyTo: ChatMessagePartial }) {
	const { t } = useTranslation("chats")

	return (
		<div className="mb-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
			<CornerUpRightIcon className="size-3 shrink-0" />
			<span className="shrink-0 font-medium">{t("chatReplyingTo", { name: senderName(replyTo) })}</span>
			{replyTo.message !== undefined && replyTo.message.length > 0 ? (
				<span className="min-w-0 truncate">{replyTo.message}</span>
			) : null}
		</div>
	)
}

export interface MessageRowProps {
	chat: Chat
	message: ChatMessage
	// First row of a burst — carries the avatar + name + timestamp header; subsequent rows indent under it.
	showHeader: boolean
	currentUserId: bigint | undefined
}

// One message row (Discord-style flat author-grouped runs). A burst opener renders the avatar gutter + a
// header line (colored name + time); a continuation renders the body only, flush under the text column,
// its avatar gutter empty at rest but revealing this line's own small timestamp on hover. Every row tints
// on hover and floats a top-right action bar (MessageActionBar) on hover/focus. There is no deleted
// tombstone: the wasm ChatMessage has no deleted flag — deletions remove the message outright
// (socketHandlers.ts's messageDelete handler drops it from the cache), so the only special body state here
// is undecryptable (message === undefined → placeholder). Carries its own right-click menu; the delete
// confirm dialog is owned HERE (not the menu content) so it survives past the menu's own close.
export function MessageRow({ chat, message, showHeader, currentUserId }: MessageRowProps) {
	const { t } = useTranslation(["chats", "common"])
	const undecryptable = message.message === undefined
	const senderAvatar = message.senderAvatar
	const avatarUrl = senderAvatar?.startsWith("http") === true ? senderAvatar : undefined
	const name = senderName(message)
	// Name coloring is a group-chat signal only — inert (undefined → default foreground) in a 1:1 (a chat
	// with at most two participants). Seeded by the stable numeric senderId, not the mutable nickname.
	const nameColor = senderNameColor(String(message.senderId), chat.participants.length <= 2)
	// The optimistic copy's uuid IS its inflightId, so this read resolves an in-flight/failed own message
	// to "pending"/"failed" and every confirmed (real-uuid) message to "confirmed".
	const sendState = useChatSendState(message.uuid)
	// Pure/sync (no query) — just enough to gate the menu's "Disable embed" entry without waiting on
	// the async resolution MessageEmbeds itself triggers.
	const hasEmbeds = !message.embedDisabled && embedCandidatesForLinks(extractMessageLinks(message.message)).length > 0

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

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger
					render={
						<div
							className={cn(
								"group relative flex w-full gap-2.5 px-4 transition-colors hover:bg-accent/40",
								showHeader ? "pt-[17px] pb-0.5" : "py-0.5"
							)}
						>
							<div className="flex w-9 shrink-0 justify-center">
								{showHeader ? (
									<Avatar>
										{/* crossOrigin: require-corp COEP needs a CORS-mode request for this
										    cross-origin egest url (see avatarCard.tsx's matching comment). */}
										{avatarUrl !== undefined ? (
											<AvatarImage
												src={avatarUrl}
												crossOrigin="anonymous"
											/>
										) : null}
										<AvatarFallback>{name.trim().charAt(0).toUpperCase() || "?"}</AvatarFallback>
									</Avatar>
								) : (
									// Continuation rows keep the avatar gutter empty at rest, revealing this exact line's
									// own timestamp only on hover — a precise time is always a hover away without adding
									// noise to the dense run (mirrors the row menus' own opacity-0/group-hover idiom).
									<span className="mt-0.5 text-[10px] leading-5 text-muted-foreground tabular-nums opacity-0 transition-opacity group-hover:opacity-100">
										{formatClockTime(message.sentTimestamp)}
									</span>
								)}
							</div>
							<div className="flex min-w-0 flex-1 flex-col">
								{showHeader ? (
									<div className="flex items-baseline gap-2">
										<span
											className="truncate text-sm font-semibold"
											style={nameColor !== undefined ? { color: nameColor } : undefined}
										>
											{name}
										</span>
										<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
											{formatClockTime(message.sentTimestamp)}
										</span>
									</div>
								) : null}
								{message.replyTo !== undefined ? <ReplyReference replyTo={message.replyTo} /> : null}
								{undecryptable ? (
									<span className="text-sm text-muted-foreground italic">{t("chatMessageUndecryptable")}</span>
								) : (
									<span className={cn("min-w-0", (sendState === "pending" || sendState === "sending") && "opacity-60")}>
										<MessageContent
											chat={chat}
											text={message.message}
										/>
										{message.edited ? (
											<span className="ml-1 text-[11px] text-muted-foreground">{t("chatMessageEdited")}</span>
										) : null}
										<MessageEmbeds
											text={message.message}
											embedDisabled={message.embedDisabled}
										/>
									</span>
								)}
								{sendState === "pending" || sendState === "sending" ? (
									<span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
										<ClockIcon className="size-3 shrink-0" />
										{t("chatMessageSending")}
									</span>
								) : null}
								{sendState === "failed" ? (
									<span className="mt-0.5 flex items-center gap-1 text-[11px] text-destructive">
										<AlertCircleIcon className="size-3 shrink-0" />
										{t("chatMessageFailed")}
									</span>
								) : null}
							</div>
							<MessageActionBar
								chat={chat}
								message={message}
								currentUserId={currentUserId}
								sendState={sendState}
								hasEmbeds={hasEmbeds}
								onRequestDelete={requestDelete}
							/>
						</div>
					}
				/>
				<MessageContextMenuContent
					chat={chat}
					message={message}
					currentUserId={currentUserId}
					sendState={sendState}
					hasEmbeds={hasEmbeds}
					onRequestDelete={requestDelete}
				/>
			</ContextMenu>
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
