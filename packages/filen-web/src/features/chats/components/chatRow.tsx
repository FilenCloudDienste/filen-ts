import { type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { VolumeOffIcon } from "lucide-react"
import type { Chat } from "@filen/sdk-rs"
import { cn, type BlockedUsers } from "@filen/shared"
import { chatTitle, chatMessagePreview, chatAvatarUrl, chatPreviewTier } from "@/features/chats/lib/sort"
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

export interface ChatRowProps {
	chat: Chat
	selected: boolean
	// True while this chat is part of a Ctrl/Cmd/Shift-click multi-selection (useChatsListSelection) —
	// distinct from `selected` (the currently-ROUTED conversation): a multi-selection can include chats
	// that are not the open thread at all, mirrors noteRow.tsx's own selected/multiSelected split.
	multiSelected: boolean
	// The next row is the routed one: its filled background replaces this row's separator.
	beforeSelected: boolean
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

// One conversation row: an unread dot (derived client-side), avatar, display name, relative time, a
// two-line last-message preview, and a muted affordance. The row container is the sidebar listbox's option
// (it carries the selection ring); the Link inside it is the activation target — a Link to /chats/$uuid,
// where the uuid is a selection key, not a path hierarchy (mirrors NoteRow) — with the ⋯ trigger button as
// its sibling, not its descendant (a <button> nested inside an <a> is invalid content model — same
// rationale as noteRow.tsx). Carries its own row-level context menu (right-click) and ⋯ trigger
// (hover-revealed), both rendering the SAME shared descriptor list (chatMenu.logic.ts) the thread header's
// own menu uses.
export function ChatRow({
	chat,
	selected,
	multiSelected,
	beforeSelected,
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
	// chatPreviewTier owns the DECISION (typing > blocked > message > empty); this line owns the COPY.
	// `typingLabel ?? …` short-circuits exactly the "typing" tier, so no narrowing cast is needed.
	const previewBlocked = chatPreviewTier(chat, typingLabel, blocked) === "blocked"
	const preview = typingLabel ?? (previewBlocked ? t("chatMessageHiddenBlocked") : (chatMessagePreview(chat) ?? t("chatNoMessages")))
	const avatarUrl = chatAvatarUrl(chat, currentUserId)
	// Client-derived numeric unread — the count of this chat's messages newer than lastFocus, from a
	// blocked sender excluded, off the passive message cache (never a per-chat SDK round trip). A
	// still-unresolved cache reads as 0 until the shell's bulk refetch fills it.
	const unreadCount = useChatUnreadCount(chat, currentUserId, blocked)
	const unread = unreadCount > 0
	const timestamp = chat.lastMessage?.sentTimestamp
	const press = useTouchLongPress<HTMLDivElement>({ onLongPress })

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
							// The separator is inset to the text column (px-2 + dot + gaps + avatar = 78px) and runs
							// under the ⋯ trigger; the routed row's fill replaces it and the one above it.
							"group relative flex h-full w-full items-center gap-1 rounded-xl px-2 transition-colors app-region-no-drag",
							"after:pointer-events-none after:absolute after:right-2 after:bottom-0 after:left-[78px] after:border-b after:border-border/60",
							selected ? "bg-chat-own text-chat-own-foreground" : "hover:bg-sidebar-accent/60",
							(selected || beforeSelected) && "after:hidden",
							multiSelected && "ring-2 ring-inset",
							multiSelected && (selected ? "ring-chat-own-foreground/70" : "ring-chat-own/60")
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
							className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left focus-ring-row outline-none"
						>
							{/* Always rendered so the column never shifts; the count lives in its label. */}
							<span
								role={unread ? "img" : undefined}
								aria-label={unread ? t("chatUnreadCount", { count: unreadCount }) : undefined}
								aria-hidden={unread ? undefined : true}
								className={cn(
									"size-2.5 shrink-0 rounded-full",
									unread && (selected ? "bg-chat-own-foreground" : "bg-chat-own")
								)}
							/>
							<UserAvatar
								src={avatarUrl}
								name={name}
								size="lg"
								fallbackClassName={selected ? "bg-chat-own-foreground/20 text-chat-own-foreground" : undefined}
							/>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<div className="flex min-w-0 items-center gap-1.5">
									{chat.muted ? (
										<VolumeOffIcon
											aria-label={t("chatMuted")}
											className={cn(
												"size-3 shrink-0",
												selected ? "text-chat-own-foreground/80" : "text-muted-foreground"
											)}
										/>
									) : null}
									<span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold" : "font-medium")}>
										{name}
									</span>
									{timestamp !== undefined ? (
										<span
											className={cn(
												"shrink-0 text-[11px] tabular-nums",
												selected ? "text-chat-own-foreground/80" : "text-muted-foreground"
											)}
										>
											{formatRelativeTime(Number(timestamp), tCommon, now)}
										</span>
									) : null}
								</div>
								{/* A substituted preview ignores the unread treatment — the hidden line is not
								content the reader is being invited to catch up on. */}
								<span
									className={cn(
										"line-clamp-2 text-xs break-words",
										(previewBlocked || typingLabel !== null) && "italic",
										selected
											? "text-chat-own-foreground/80"
											: unread && !previewBlocked
												? "text-foreground"
												: "text-muted-foreground"
									)}
								>
									{preview}
								</span>
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
