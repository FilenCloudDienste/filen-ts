import { type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { VolumeOffIcon } from "lucide-react"
import type { Chat } from "@filen/sdk-rs"
import { cn, type BlockedUsers } from "@filen/shared"
import { chatTitle, chatMessagePreview, chatAvatarUrl, chatPreviewTier, messageSenderName } from "@/features/chats/lib/sort"
import { isOwnMessage } from "@/features/chats/lib/sender"
import { isGroupChat } from "@/features/chats/components/thread/thread.logic"
import { useChatUnreadCount } from "@/features/chats/hooks/useChatUnreadCount"
import { useChatTypingLabel } from "@/features/chats/hooks/useChatTyping"
import { formatRelativeTime } from "@/lib/relativeTime"
import { useNowMinute } from "@/lib/useNowMinute"
import { selectionAwareLinkClick } from "@/features/drive/lib/listbox"
import { ChatContextMenuContent, ChatDropdownMenuContent } from "@/features/chats/components/chatMenu"
import { type ChatActionDialogKind } from "@/features/chats/components/chatMenu.logic"
import { UserAvatar } from "@/components/userAvatar"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu } from "@/components/ui/dropdown-menu"
import { RowMenuTrigger } from "@/components/rowMenuTrigger"
import { useTouchLongPress } from "@/lib/useTouchLongPress"

// The unread pill shows counts up to this, then "99+".
const MAX_PILL_COUNT = 99

export interface ChatRowProps {
	chat: Chat
	selected: boolean
	// True while this chat is part of a Ctrl/Cmd/Shift-click multi-selection (useChatsListSelection) —
	// distinct from `selected` (the currently-ROUTED conversation): a multi-selection can include chats
	// that are not the open thread at all, mirrors noteRow.tsx's own selected/multiSelected split.
	multiSelected: boolean
	// Virtualized list: only a window of rows is mounted, so the DOM child count is a fabricated total
	// and the position has to be threaded from the owning list.
	posInSet: number
	setSize: number
	currentUserId: bigint | undefined
	// From the sidebar's single enabled read (useBlockedUsers) — no per-row contacts observer.
	blocked: BlockedUsers
	// Threaded straight through to the row's own menu (chatMenu.tsx's onAction) — the sidebar's ONE
	// dialog host (useChatDialogHost) is the actual dialog-opening implementation, not this row.
	onAction: (kind: ChatActionDialogKind, chat: Chat) => void
	// Modifier-click selection — mirrors noteRow.tsx's own onPointerSelect: a plain click or touch tap
	// lets navigation proceed; a selection gesture returns true and never navigates (see the Link below).
	onPointerSelect: (event: MouseEvent<HTMLAnchorElement>, pointerType: string) => boolean
	// A touch long-press: a Ctrl/Cmd+click's toggle, in place of the context menu.
	onLongPress: () => void
}

// One compact conversation row: avatar, display name (bold while unread), relative time, a one-line
// last-message preview (prefixed with its sender in a group, "You" for own), an unread count pill and a
// muted affordance. The row container is the section listbox's option (it carries the multi-selection ring); the
// Link inside it is the activation target — a Link to /chats/$uuid, where the uuid is a selection key, not a
// path hierarchy (mirrors NoteRow) — with the ⋯ trigger button as its sibling, not its descendant (a
// <button> nested inside an <a> is invalid content model — same rationale as noteRow.tsx). Carries its own
// row-level context menu (right-click) and ⋯ trigger (hover-revealed), both rendering the SAME shared
// descriptor list (chatMenu.logic.ts) the thread header's own menu uses.
export function ChatRow({
	chat,
	selected,
	multiSelected,
	posInSet,
	setSize,
	currentUserId,
	blocked,
	onAction,
	onPointerSelect,
	onLongPress
}: ChatRowProps) {
	const { t } = useTranslation("chats")
	const { t: tCommon } = useTranslation("common")
	const now = useNowMinute()
	const name = chatTitle(chat, currentUserId, t("chatUndecryptable"), t("chatJustYou"))
	const typingLabel = useChatTypingLabel(chat.uuid, currentUserId)
	// chatPreviewTier owns the DECISION (typing > blocked > message > empty); this row owns the COPY.
	const tier = chatPreviewTier(chat, typingLabel, blocked)
	const avatarUrl = chatAvatarUrl(chat, currentUserId)
	// Client-derived numeric unread — the count of this chat's messages newer than lastFocus, from a
	// blocked sender excluded, off the passive message cache (never a per-chat SDK round trip). A
	// still-unresolved cache reads as 0 until the shell's bulk refetch fills it.
	const unreadCount = useChatUnreadCount(chat, currentUserId, blocked)
	const unread = unreadCount > 0
	const timestamp = chat.lastMessage?.sentTimestamp
	const press = useTouchLongPress<HTMLDivElement>({ onLongPress })

	function previewText(): string {
		if (tier === "typing" && typingLabel !== null) {
			return typingLabel
		}

		if (tier === "blocked") {
			return t("chatMessageHiddenBlocked")
		}

		const lastMessage = chat.lastMessage
		const message = chatMessagePreview(chat)

		if (tier !== "message" || lastMessage === undefined || message === null) {
			return t("chatNoMessages")
		}

		if (isOwnMessage(lastMessage, currentUserId)) {
			return t("chatPreviewWithSender", { name: t("chatSenderYou"), message })
		}

		return isGroupChat(chat.participants.length)
			? t("chatPreviewWithSender", { name: messageSenderName(lastMessage), message })
			: message
	}

	const preview = previewText()

	return (
		<ContextMenu>
			{/* render-prop merge onto the row's own div (mirrors noteRow.tsx's own idiom) — Base UI's
			ContextMenuTrigger merges its onContextMenu handler + ref onto the given element rather than
			wrapping it. */}
			<ContextMenuTrigger
				render={
					<div
						role="option"
						aria-selected={multiSelected}
						aria-posinset={posInSet}
						aria-setsize={setSize}
						{...press.handlers}
						className={cn(
							"group relative flex h-full w-full items-center gap-1 rounded-lg px-2 transition-colors app-region-no-drag",
							// An open context menu (the row's own data-popup-open) or ⋯ menu (a descendant's) holds the
							// hover highlight: CSS reads Base UI's trigger state, so no row keeps menu state of its own.
							selected
								? "bg-sidebar-accent"
								: "hover:bg-sidebar-accent/60 has-[[data-popup-open]]:bg-sidebar-accent/60 data-popup-open:bg-sidebar-accent/60",
							multiSelected && "ring-2 ring-primary/60 ring-inset"
						)}
					>
						<Link
							to="/chats/$uuid"
							params={{ uuid: chat.uuid }}
							// aria-current is a different fact from aria-selected (which lives on the option
							// container): this is the routed conversation, not necessarily a selected one.
							aria-current={selected ? "page" : undefined}
							onClick={selectionAwareLinkClick((event: MouseEvent<HTMLAnchorElement>) =>
								onPointerSelect(event, press.pointerType(event))
							)}
							className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md text-left focus-ring-row outline-none"
						>
							<UserAvatar
								src={avatarUrl}
								name={name}
							/>
							<div className="flex min-w-0 flex-1 flex-col">
								<div className="flex min-w-0 items-center gap-1.5">
									{chat.muted ? (
										<VolumeOffIcon
											aria-label={t("chatMuted")}
											className="size-3 shrink-0 text-muted-foreground"
										/>
									) : null}
									<span
										className={cn(
											"min-w-0 flex-1 truncate text-sm leading-5",
											unread ? "font-semibold" : "font-medium"
										)}
									>
										{name}
									</span>
									{timestamp !== undefined ? (
										<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
											{formatRelativeTime(Number(timestamp), tCommon, now)}
										</span>
									) : null}
								</div>
								<div className="flex min-w-0 items-center gap-1.5">
									{/* A substituted preview ignores the unread treatment — the hidden line is not
									content the reader is being invited to catch up on. */}
									<span
										className={cn(
											"min-w-0 flex-1 truncate text-xs leading-4",
											(tier === "blocked" || tier === "typing") && "italic",
											unread && tier !== "blocked" ? "text-foreground" : "text-muted-foreground"
										)}
									>
										{preview}
									</span>
									{unread ? (
										<span className="h-4 min-w-4 shrink-0 rounded-full bg-chat-own px-1 text-center text-[10px] leading-4 font-semibold text-chat-own-foreground tabular-nums">
											<span aria-hidden="true">
												{unreadCount > MAX_PILL_COUNT ? `${String(MAX_PILL_COUNT)}+` : unreadCount}
											</span>
											<span className="sr-only">{t("chatUnreadCount", { count: unreadCount })}</span>
										</span>
									) : null}
								</div>
							</div>
						</Link>
						<DropdownMenu>
							<RowMenuTrigger
								label={t("chatItemMenuTrigger")}
								reveal="plain"
							/>
							<ChatDropdownMenuContent
								chat={chat}
								currentUserId={currentUserId}
								blocked={blocked}
								onAction={onAction}
							/>
						</DropdownMenu>
					</div>
				}
			/>
			<ChatContextMenuContent
				chat={chat}
				currentUserId={currentUserId}
				blocked={blocked}
				onAction={onAction}
			/>
		</ContextMenu>
	)
}
