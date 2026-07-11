import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { VolumeOffIcon } from "lucide-react"
import type { Chat } from "@filen/sdk-rs"
import { cn } from "@/lib/utils"
import { chatDisplayName, isChatUndecryptable, chatMessagePreview } from "@/features/chats/lib/sort"
import { chatHasUnread } from "@/features/chats/lib/unread.logic"
import { formatListTimestamp } from "@/features/chats/lib/time"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

export interface ChatRowProps {
	chat: Chat
	selected: boolean
	currentUserId: bigint | undefined
}

// Participant-derived avatar (mobile's own rule, list/chat/index.tsx): the other participants sans self,
// keeping only real http avatar URLs. A 1:1 uses the other person's image; anything else falls back to the
// display name's initial. No composite group avatar this wave — a single representative image or initial.
function resolveAvatarUrl(chat: Chat, currentUserId: bigint | undefined): string | undefined {
	const others = chat.participants.filter(p => p.userId !== currentUserId)

	if (others.length !== 1) {
		return undefined
	}

	const avatar = others[0]?.avatar

	return avatar?.startsWith("http") === true ? avatar : undefined
}

// One conversation row: avatar, display name, last-message preview, relative time, a per-row unread badge
// (D4, derived client-side), and a muted affordance. The whole row is a Link to /chats/$uuid — the uuid is
// a selection key, not a path hierarchy (mirrors NoteRow). Menus/actions land in a later wave, so this row
// carries no context menu yet.
export function ChatRow({ chat, selected, currentUserId }: ChatRowProps) {
	const { t } = useTranslation("chats")
	const undecryptable = isChatUndecryptable(chat)
	const name = undecryptable ? t("chatUndecryptable") : currentUserId !== undefined ? chatDisplayName(chat, currentUserId) : chat.uuid
	const preview = chatMessagePreview(chat) ?? t("chatNoMessages")
	const avatarUrl = resolveAvatarUrl(chat, currentUserId)
	const unread = chatHasUnread(chat, currentUserId)
	const timestamp = chat.lastMessage?.sentTimestamp

	return (
		<Link
			to="/chats/$uuid"
			params={{ uuid: chat.uuid }}
			aria-current={selected ? "page" : undefined}
			className={cn(
				"group flex h-full w-full items-center gap-2.5 rounded-xl px-2.5 transition-colors outline-none app-region-no-drag focus-visible:ring-3 focus-visible:ring-ring/30",
				selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60"
			)}
		>
			<Avatar>
				{avatarUrl !== undefined ? <AvatarImage src={avatarUrl} /> : null}
				<AvatarFallback>{name.trim().charAt(0).toUpperCase() || "?"}</AvatarFallback>
			</Avatar>
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex min-w-0 items-center gap-1.5">
					{chat.muted ? (
						<VolumeOffIcon
							aria-label={t("chatMuted")}
							className="size-3 shrink-0 text-muted-foreground"
						/>
					) : null}
					<span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold" : "font-medium")}>{name}</span>
					{timestamp !== undefined ? (
						<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{formatListTimestamp(timestamp)}</span>
					) : null}
				</div>
				<div className="flex min-w-0 items-center gap-1.5">
					<span className={cn("min-w-0 flex-1 truncate text-xs", unread ? "text-foreground" : "text-muted-foreground")}>
						{preview}
					</span>
					{unread ? (
						<span
							aria-label={t("chatUnread")}
							className="size-2 shrink-0 rounded-full bg-primary"
						/>
					) : null}
				</div>
			</div>
		</Link>
	)
}
