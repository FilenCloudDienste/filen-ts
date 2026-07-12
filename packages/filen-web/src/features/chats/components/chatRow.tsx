import { type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { VolumeOffIcon, MoreHorizontalIcon } from "lucide-react"
import type { Chat } from "@filen/sdk-rs"
import { cn } from "@/lib/utils"
import { chatDisplayName, isChatUndecryptable, chatMessagePreview, chatAvatarUrl } from "@/features/chats/lib/sort"
import { useChatUnreadCount } from "@/features/chats/hooks/useChatUnreadCount"
import { useChatTypingLabel } from "@/features/chats/hooks/useChatTyping"
import { formatRelativeTime } from "@/lib/relativeTime"
import { ChatContextMenuContent, ChatDropdownMenuContent } from "@/features/chats/components/chatMenu"
import { type ChatActionDialogKind } from "@/features/chats/components/chatMenu.logic"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

export interface ChatRowProps {
	chat: Chat
	selected: boolean
	// True while this chat is part of a Ctrl/Cmd/Shift-click multi-selection (useChatsListSelection) —
	// distinct from `selected` (the currently-ROUTED conversation): a multi-selection can include chats
	// that are not the open thread at all, mirrors noteRow.tsx's own selected/multiSelected split.
	multiSelected: boolean
	currentUserId: bigint | undefined
	// Threaded straight through to the row's own menu (chatMenu.tsx's onAction) — the sidebar's ONE
	// dialog host (useChatDialogHost) is the actual dialog-opening implementation, not this row.
	onAction: (kind: ChatActionDialogKind, chat: Chat) => void
	// Modifier-click selection — mirrors noteRow.tsx's own onPointerSelect. Fired from the Link's own
	// onClick: a plain click lets navigation proceed; Ctrl/Cmd/Shift+click call preventDefault first
	// (see the Link below) and never navigate.
	onPointerSelect: (event: MouseEvent<HTMLAnchorElement>) => void
}

// One conversation row: avatar, display name, last-message preview, relative time, a per-row unread badge
// (derived client-side), and a muted affordance. Most of the row is a Link to /chats/$uuid — the uuid
// is a selection key, not a path hierarchy (mirrors NoteRow) — with the ⋯ trigger button as its sibling,
// not its descendant (a <button> nested inside an <a> is invalid content model — same rationale as
// noteRow.tsx). Carries its own row-level context menu (right-click) and ⋯ trigger (hover-revealed), both
// rendering the SAME shared descriptor list (chatMenu.logic.ts) the thread header's own menu uses.
export function ChatRow({ chat, selected, multiSelected, currentUserId, onAction, onPointerSelect }: ChatRowProps) {
	const { t } = useTranslation("chats")
	const { t: tCommon } = useTranslation("common")
	const undecryptable = isChatUndecryptable(chat)
	const name = undecryptable ? t("chatUndecryptable") : currentUserId !== undefined ? chatDisplayName(chat, currentUserId) : chat.uuid
	// Typing beats the last-message preview while any remote user is actively typing — the tier
	// chatMessagePreview (lib/sort.ts) itself does not cover. Falls back to the message preview when nobody is typing.
	const typingLabel = useChatTypingLabel(chat.uuid, currentUserId)
	const preview = typingLabel ?? chatMessagePreview(chat) ?? t("chatNoMessages")
	const avatarUrl = chatAvatarUrl(chat, currentUserId)
	// Client-derived numeric unread (P7) — the count of this chat's messages newer than lastFocus, from a
	// blocked sender excluded, off the passive message cache (never a per-chat SDK round trip). A
	// still-unresolved cache reads as 0 until the shell's bulk refetch fills it.
	const unreadCount = useChatUnreadCount(chat, currentUserId)
	const unread = unreadCount > 0
	const timestamp = chat.lastMessage?.sentTimestamp

	return (
		<ContextMenu>
			{/* render-prop merge onto the row's own div (mirrors noteRow.tsx's own idiom) — Base UI's
			ContextMenuTrigger merges its onContextMenu handler + ref onto the given element rather than
			wrapping it. */}
			<ContextMenuTrigger
				render={
					<div
						className={cn(
							"group flex h-full w-full items-center gap-2.5 rounded-xl px-2.5 transition-colors app-region-no-drag",
							selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
							multiSelected && "ring-2 ring-primary/60 ring-inset"
						)}
					>
						<Link
							to="/chats/$uuid"
							params={{ uuid: chat.uuid }}
							aria-current={selected ? "page" : undefined}
							aria-selected={multiSelected}
							onClick={event => {
								// Ctrl/Cmd/Shift held: this is a selection gesture, not a navigation intent —
								// preventDefault blocks BOTH the router's own SPA navigate (which already skips
								// itself on a modified click) AND the browser's native "open in new tab" default
								// a real anchor would otherwise still run. A plain click falls through unprevented
								// so navigation proceeds exactly as before, alongside collapsing the selection to
								// just this chat (drive/notes' own plain-click-selects-one semantics).
								if (event.metaKey || event.ctrlKey || event.shiftKey) {
									event.preventDefault()
								}

								onPointerSelect(event)
							}}
							className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
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
									<span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold" : "font-medium")}>
										{name}
									</span>
									{timestamp !== undefined ? (
										<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
											{formatRelativeTime(Number(timestamp), tCommon)}
										</span>
									) : null}
								</div>
								<div className="flex min-w-0 items-center gap-1.5">
									<span
										className={cn(
											"min-w-0 flex-1 truncate text-xs",
											unread ? "text-foreground" : "text-muted-foreground"
										)}
									>
										{preview}
									</span>
									{unread ? (
										<span
											aria-label={t("chatUnreadCount", { count: unreadCount })}
											className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground tabular-nums"
										>
											{unreadCount}
										</span>
									) : null}
								</div>
							</div>
						</Link>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label={t("chatItemMenuTrigger")}
										className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
										onClick={event => {
											// The button is a sibling of the Link now, not a descendant, so a click here
											// can never bubble into a navigation — this only stops it reaching the row
											// div's own onContextMenu, mirroring noteRow.tsx's matching trigger.
											event.stopPropagation()
										}}
									>
										<MoreHorizontalIcon />
									</Button>
								}
							/>
							<ChatDropdownMenuContent
								chat={chat}
								currentUserId={currentUserId}
								onAction={onAction}
							/>
						</DropdownMenu>
					</div>
				}
			/>
			<ChatContextMenuContent
				chat={chat}
				currentUserId={currentUserId}
				onAction={onAction}
			/>
		</ContextMenu>
	)
}
