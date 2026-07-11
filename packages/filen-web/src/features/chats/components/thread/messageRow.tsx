import { useTranslation } from "react-i18next"
import { CornerUpRightIcon } from "lucide-react"
import type { Chat, ChatMessage, ChatMessagePartial } from "@filen/sdk-rs"
import { cn } from "@/lib/utils"
import { formatClockTime } from "@/features/chats/lib/time"
import { MessageContent } from "@/features/chats/components/thread/messageContent"
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
}

// One message row (D3 dense grouped flat rows). A burst opener renders the avatar gutter + a header line
// (name + time); a continuation renders the body only, indented under the gutter. There is no deleted
// tombstone: the wasm ChatMessage has no deleted flag — deletions remove the message outright (a later
// wave's socket handler drops it from the cache), so the only special body state here is undecryptable
// (message === undefined → placeholder).
export function MessageRow({ chat, message, showHeader }: MessageRowProps) {
	const { t } = useTranslation("chats")
	const undecryptable = message.message === undefined
	const senderAvatar = message.senderAvatar
	const avatarUrl = senderAvatar?.startsWith("http") === true ? senderAvatar : undefined
	const name = senderName(message)

	return (
		<div className={cn("flex w-full gap-2.5 px-4", showHeader ? "pt-3" : "pt-0.5")}>
			<div className="w-9 shrink-0">
				{showHeader ? (
					<Avatar>
						{avatarUrl !== undefined ? <AvatarImage src={avatarUrl} /> : null}
						<AvatarFallback>{name.trim().charAt(0).toUpperCase() || "?"}</AvatarFallback>
					</Avatar>
				) : null}
			</div>
			<div className="flex min-w-0 flex-1 flex-col">
				{showHeader ? (
					<div className="flex items-baseline gap-2">
						<span className="truncate text-sm font-semibold">{name}</span>
						<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
							{formatClockTime(message.sentTimestamp)}
						</span>
					</div>
				) : null}
				{message.replyTo !== undefined ? <ReplyReference replyTo={message.replyTo} /> : null}
				{undecryptable ? (
					<span className="text-sm text-muted-foreground italic">{t("chatMessageUndecryptable")}</span>
				) : (
					<span className="min-w-0">
						<MessageContent
							chat={chat}
							text={message.message}
						/>
						{message.edited ? <span className="ml-1 text-[11px] text-muted-foreground">{t("chatMessageEdited")}</span> : null}
					</span>
				)}
			</div>
		</div>
	)
}
