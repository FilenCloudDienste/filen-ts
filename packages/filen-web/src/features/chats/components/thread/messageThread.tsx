import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { MoreHorizontalIcon, ArrowDownIcon } from "lucide-react"
import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { useChatMessages, loadOlderChatMessages } from "@/features/chats/queries/chatMessages"
import {
	buildThreadRows,
	computeScrollAfterPrepend,
	countNewTailMessages,
	isScrollNearBottom,
	nextScrollAffordanceState,
	nextAnnouncement,
	INITIAL_SCROLL_AFFORDANCE,
	type ThreadAnnouncement
} from "@/features/chats/components/thread/thread.logic"
import { composeMessageList, type OptimisticSender } from "@/features/chats/lib/sync.logic"
import { useChatsInflightStore } from "@/features/chats/store/useChatsInflight"
import { Composer } from "@/features/chats/components/thread/composer"
import { TypingIndicator } from "@/features/chats/components/thread/typingIndicator"
import { setFocusedChat } from "@/features/chats/lib/focusedChat"
import { dayKind, formatFullDate } from "@/features/chats/lib/time"
import { chatDisplayName, isChatUndecryptable, chatAvatarUrl, messageSenderName } from "@/features/chats/lib/sort"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { isBlocked } from "@/features/contacts/lib/blocking"
import { useRevealedBlockedMessages } from "@/features/chats/store/useRevealedBlockedMessages"
import { markChatRead } from "@/features/chats/lib/actions"
import { MessageRow } from "@/features/chats/components/thread/messageRow"
import { ChatDropdownMenuContent } from "@/features/chats/components/chatMenu"
import { useChatDialogHost } from "@/features/chats/hooks/useChatDialogHost"
import { useAccountQuery } from "@/queries/account"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// Estimates for the virtualizer's first pass; real heights come from measureElement (message rows vary in
// height with content). A day separator is a single fixed pill.
const DAY_ROW_ESTIMATE = 44
const MESSAGE_ROW_ESTIMATE = 56
// Load older when the user scrolls within this many px of the top.
const TOP_THRESHOLD = 120
// "At bottom" for the scroll-to-bottom affordance / auto-stick purposes.
const BOTTOM_THRESHOLD = 80

function DaySeparator({ timestamp }: { timestamp: bigint }) {
	const { t } = useTranslation("chats")
	const kind = dayKind(timestamp)
	const label = kind === "today" ? t("chatDayToday") : kind === "yesterday" ? t("chatDayYesterday") : formatFullDate(timestamp)

	return (
		<div className="flex items-center justify-center py-2">
			{/* text-foreground, not text-muted-foreground: muted on the muted pill computes 4.34:1 in
			light, under the 4.5:1 floor for 11px text. */}
			<span className="rounded-full bg-muted px-3 py-0.5 text-[11px] font-medium text-foreground">{label}</span>
		</div>
	)
}

// The "New" divider — old-web's NewDivider, one-time-guarded placement (thread.logic.ts's buildThreadRows)
// AND click-to-mark-read (old-web: clicking it emits chatMarkAsRead). The chat's own lastFocus advancing
// on success removes this row on the next render — never dismissed locally, always server-driven.
function UnreadDivider({ chat }: { chat: Chat }) {
	const { t } = useTranslation("chats")
	const [pending, setPending] = useState(false)

	async function handleClick(): Promise<void> {
		if (pending) {
			return
		}

		setPending(true)
		await markChatRead(chat)
		setPending(false)
	}

	return (
		<div className="flex items-center gap-2 px-4 py-2">
			<button
				type="button"
				disabled={pending}
				onClick={() => {
					void handleClick()
				}}
				className="flex flex-1 items-center gap-2 disabled:opacity-60"
			>
				{/* text-primary-foreground, not text-white: white on destructive computes 2.89:1 in dark. */}
				<span className="shrink-0 rounded-full bg-destructive px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
					{t("chatUnreadDivider")}
				</span>
				<span className="h-px flex-1 bg-destructive/60" />
			</button>
		</div>
	)
}

// Floating scroll-to-bottom pill — appears once the user has scrolled up AND at least one message has
// landed below the viewport since (thread.logic.ts's nextScrollAffordanceState). Click scrolls to bottom;
// the resulting scroll event clears it via the same reducer (no separate "dismiss" path).
function ScrollToBottomFab({ count, onClick }: { count: number; onClick: () => void }) {
	const { t } = useTranslation("chats")

	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={t("chatScrollToBottom", { count })}
			className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-md"
		>
			<ArrowDownIcon className="size-3.5" />
			{t("chatNewMessagesCount", { count })}
		</button>
	)
}

// Conversation thread (dense grouped flat rows). Messages ascend (oldest→newest); the list is
// virtualized (@tanstack/react-virtual — the app's own virtualizer, notesSidebar's convention) and opens
// pinned to the bottom (newest). Scrolling to the top loads one older page via loadOlderChatMessages
// (prepend + dedupe) with scroll-position preservation. The composer strip at the bottom routes every
// send through the outbox (Composer); an own send jumps the view back to the bottom. The header's ⋮
// trigger hosts the conversation menu
// (rename/mute/participants/leave/delete + the explicit "mark as read" entry) — one of two places
// markChatRead is wired (chatMenu.tsx's row context menu is the other): never auto-fired on mount —
// old-web's explicit-mark model, not mobile's own screen-open trigger.
export function MessageThread({ chat }: { chat: Chat }) {
	const { t } = useTranslation("chats")
	const chatUuid = chat.uuid
	const accountQuery = useAccountQuery()
	const currentUserId = accountQuery.data?.id
	const messagesQuery = useChatMessages(chatUuid)
	// Enabled, deliberately: every blocked-dependent surface in the thread (row tombstone, reply-reference
	// redaction, unread-divider suppression, the live-region gate) reads this one value, so thread
	// correctness must not depend on the sidebar happening to be mounted alongside it. Costs one extra
	// observer on a query key the sidebar already holds — TanStack dedupes the fetch. Do not set it false.
	const blocked = useBlockedUsers(true)
	// Select the raw outbox maps (stable references — only change on a store write, so no getSnapshot
	// churn) and derive this chat's pending/failed entries in render; the composed list re-injects them
	// on top of the confirmed message cache so a query refetch never drops an in-flight/failed bubble.
	const inflightMessagesMap = useChatsInflightStore(state => state.inflightMessages)
	const inflightErrorsMap = useChatsInflightStore(state => state.inflightErrors)
	const queuedMessages = inflightMessagesMap[chatUuid]?.messages ?? []
	const failedMessages = Object.values(inflightErrorsMap)
		.filter(entry => entry.message.chat === chatUuid)
		.map(entry => entry.message)
	const messages = composeMessageList({
		queryMessages: messagesQuery.data ?? [],
		inflightMessages: queuedMessages,
		failedMessages
	})
	// uuids of uncommitted optimistic entries (queued or failed) — their uuid IS their inflightId, so the
	// composer excludes them from the ArrowUp-edit target (an uncommitted send has no server uuid to edit).
	const nonConfirmedUuids = new Set<string>([...queuedMessages, ...failedMessages].map(message => message.uuid))
	const dialogHost = useChatDialogHost({ currentUuid: chatUuid })

	const scrollRef = useRef<HTMLDivElement | null>(null)
	const [loadingOlder, setLoadingOlder] = useState(false)
	// Per-chat pagination bookkeeping (instance state in refs — React Compiler owns memoization).
	const hasMoreRef = useRef(true)
	const lastCursorRef = useRef<bigint | null>(null)
	const initialScrollChatRef = useRef<string | null>(null)
	// Set at load-older trigger time so the post-prepend layout effect can restore the viewport.
	const restoreRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null)
	// Set on an own send so the next list growth jumps the view to the bottom (mobile parity — sending
	// while scrolled up snaps back to the newest message). Also tells the messagesArrived effect below
	// this particular tail growth is our own — don't badge it, the stick-to-bottom scroll is already
	// underway.
	const stickBottomRef = useRef(false)
	const suppressNextArrivalRef = useRef(false)
	// The scroll-to-bottom pill's derived state (thread.logic.ts's pure reducer) — needs to drive a
	// visible re-render (the pill's own count), unlike the pagination bookkeeping above.
	const [affordance, setAffordance] = useState(INITIAL_SCROLL_AFFORDANCE)
	const [announcement, setAnnouncement] = useState<ThreadAnnouncement | null>(null)
	// Full previous snapshot (not just `.length`) — countNewTailMessages needs the actual last message to
	// tell a tail arrival from a head prepend; length alone can't.
	const prevMessagesRef = useRef<readonly ChatMessage[]>([])

	const sender: OptimisticSender | undefined =
		accountQuery.data !== undefined
			? {
					id: accountQuery.data.id,
					email: accountQuery.data.email,
					avatarUrl: accountQuery.data.avatarUrl,
					nickName: accountQuery.data.nickName
				}
			: undefined

	const rows = buildThreadRows(messages, currentUserId !== undefined ? { lastFocus: chat.lastFocus, currentUserId, blocked } : undefined)

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: index => (rows[index]?.kind === "message" ? MESSAGE_ROW_ESTIMATE : DAY_ROW_ESTIMATE),
		overscan: 8,
		getItemKey: index => rows[index]?.key ?? index
	})

	// Reset pagination + the scroll-to-bottom pill when the selected conversation changes — a fresh chat may
	// have older history and its own bottom-anchor; the previous chat's unseen count never carries over.
	// Revealed blocked messages reset too, so re-entering a conversation re-hides them.
	useEffect(() => {
		hasMoreRef.current = true
		lastCursorRef.current = null
		prevMessagesRef.current = []
		suppressNextArrivalRef.current = false
		setAffordance(INITIAL_SCROLL_AFFORDANCE)
		setAnnouncement(null)
		useRevealedBlockedMessages.getState().clear()
	}, [chatUuid])

	// Grow the pill's count when messages land at the TAIL while the user is scrolled up (thread.logic.ts's
	// reducer no-ops this while at bottom). Keyed off countNewTailMessages, not raw length growth: a
	// loadOlderChatMessages prepend also grows `messages.length` (it fires precisely when scrolled to the
	// top), and that must NOT inflate this count. An own send DOES momentarily grow the tail before the
	// stick-to-bottom layout effect's scroll fires — suppressNextArrivalRef (set alongside stickBottomRef)
	// swallows exactly that one growth so the pill never flashes for our own message.
	useEffect(() => {
		const newTailCount = countNewTailMessages(prevMessagesRef.current, messages)
		prevMessagesRef.current = messages

		if (newTailCount <= 0) {
			return
		}

		if (suppressNextArrivalRef.current) {
			suppressNextArrivalRef.current = false
			return
		}

		const latest = messages[messages.length - 1]

		// Own messages sent from another tab/device arrive as a normal tail growth — suppressNextArrivalRef
		// only swallows THIS tab's send. The announcement channel is held to the same blocked policy as the
		// visual surfaces: a blocked sender's name is exactly what those withhold, and this is the one
		// channel with no visual equivalent to check against.
		if (
			latest !== undefined &&
			BigInt(latest.senderId) !== currentUserId &&
			!isBlocked({ userId: BigInt(latest.senderId), email: latest.senderEmail }, blocked)
		) {
			setAnnouncement(prev => nextAnnouncement(prev, newTailCount, messageSenderName(latest)))
		}

		// The pill's count deliberately still includes blocked arrivals — it names nobody, and splitting
		// its count from the row list would make it lie about how far the thread has grown.
		setAffordance(prev => nextScrollAffordanceState(prev, { kind: "messagesArrived", count: newTailCount }))
	}, [messages, currentUserId, blocked])

	// Track the open conversation OUTSIDE React so the socket handlers can gate derived-unread: a foreign
	// message landing in the chat the user is looking at must not flip it unread. Cleared on unmount /
	// chat change.
	useEffect(() => {
		setFocusedChat(chatUuid)

		return () => {
			setFocusedChat(null)
		}
	}, [chatUuid])

	// Open pinned to the bottom, once per chat. Fires when this chat's rows first populate; the chat-uuid
	// guard keeps a later prepend (which also grows rows.length) from re-yanking the view to the bottom.
	useLayoutEffect(() => {
		const el = scrollRef.current

		if (el === null || rows.length === 0 || initialScrollChatRef.current === chatUuid) {
			return
		}

		initialScrollChatRef.current = chatUuid
		el.scrollTop = el.scrollHeight
	}, [chatUuid, rows.length])

	// Restore scroll position after an older page is prepended: the content above the viewport grew, so the
	// scrollTop must grow by the same delta to keep the same messages under the user's eye.
	useLayoutEffect(() => {
		const el = scrollRef.current
		const restore = restoreRef.current

		if (el === null || restore === null) {
			return
		}

		restoreRef.current = null
		el.scrollTop = computeScrollAfterPrepend(restore.prevScrollHeight, restore.prevScrollTop, el.scrollHeight)
	}, [rows.length])

	// Jump to the bottom after an own send appends its optimistic bubble (the list grew).
	useLayoutEffect(() => {
		const el = scrollRef.current

		if (el === null || !stickBottomRef.current) {
			return
		}

		stickBottomRef.current = false
		el.scrollTop = el.scrollHeight
	}, [rows.length])

	function scrollToBottom(): void {
		const el = scrollRef.current

		if (el === null) {
			return
		}

		el.scrollTop = el.scrollHeight
	}

	// Recomputes bottom-proximity on every scroll (clears the pill's count the instant the user — or the
	// pill's own click — reaches bottom; the reducer no-ops a redundant "still at bottom" event).
	function trackScrollAffordance(): void {
		const el = scrollRef.current

		if (el === null) {
			return
		}

		const atBottom = isScrollNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight, BOTTOM_THRESHOLD)
		setAffordance(prev => nextScrollAffordanceState(prev, { kind: "scroll", atBottom }))
	}

	async function handleScroll(): Promise<void> {
		trackScrollAffordance()

		const el = scrollRef.current

		if (el === null || el.scrollTop > TOP_THRESHOLD || loadingOlder || !hasMoreRef.current) {
			return
		}

		const oldest = messages[0]

		if (oldest === undefined || lastCursorRef.current === oldest.sentTimestamp) {
			// Same oldest cursor as the last attempt → no distinct older history to pull; stop retriggering.
			return
		}

		lastCursorRef.current = oldest.sentTimestamp
		restoreRef.current = { prevScrollHeight: el.scrollHeight, prevScrollTop: el.scrollTop }
		setLoadingOlder(true)

		try {
			const page = await loadOlderChatMessages(chat, oldest.sentTimestamp)

			if (page.length === 0) {
				hasMoreRef.current = false
			}
		} catch {
			// A failed page load leaves the current list intact; don't restore against a stale height.
			restoreRef.current = null
			hasMoreRef.current = false
		} finally {
			setLoadingOlder(false)
		}
	}

	function renderList(): ReactNode {
		if (messagesQuery.isPending) {
			return (
				<div className="flex flex-1 items-center justify-center">
					<Spinner className="size-5 text-muted-foreground" />
				</div>
			)
		}

		if (messagesQuery.isError) {
			return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t("chatThreadLoadError")}</div>
		}

		if (rows.length === 0) {
			return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t("chatThreadEmpty")}</div>
		}

		return (
			<div
				ref={scrollRef}
				onScroll={() => {
					void handleScroll()
				}}
				className="flex-1 overflow-y-auto"
			>
				{loadingOlder ? (
					<div className="flex items-center justify-center py-2">
						<Spinner
							className="size-4 text-muted-foreground"
							aria-label={t("chatLoadingOlder")}
						/>
					</div>
				) : null}
				<div
					className="relative w-full"
					style={{ height: virtualizer.getTotalSize() }}
				>
					{virtualizer.getVirtualItems().map(virtualRow => {
						const row = rows[virtualRow.index]

						if (row === undefined) {
							return null
						}

						return (
							<div
								key={virtualRow.key}
								data-index={virtualRow.index}
								ref={element => {
									virtualizer.measureElement(element)
								}}
								className="absolute top-0 left-0 w-full"
								style={{ transform: `translateY(${String(virtualRow.start)}px)` }}
							>
								{row.kind === "day" ? (
									<DaySeparator timestamp={row.timestamp} />
								) : row.kind === "unread" ? (
									<UnreadDivider chat={chat} />
								) : (
									<MessageRow
										chat={chat}
										message={row.message}
										showHeader={row.showHeader}
										currentUserId={currentUserId}
										blocked={blocked}
									/>
								)}
							</div>
						)
					})}
				</div>
			</div>
		)
	}

	const showScrollToBottomFab = !affordance.atBottom && affordance.unseenCount > 0

	const headerTitle = isChatUndecryptable(chat)
		? t("chatUndecryptable")
		: currentUserId !== undefined
			? chatDisplayName(chat, currentUserId, t("chatJustYou"))
			: chat.uuid
	const headerAvatarUrl = chatAvatarUrl(chat, currentUserId)

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 items-center gap-2.5 px-5 py-4">
				<Avatar className="size-8 shrink-0">
					{/* crossOrigin: require-corp COEP needs a CORS-mode request for this cross-origin egest
					    url (see avatarCard.tsx's matching comment). */}
					{headerAvatarUrl !== undefined ? (
						<AvatarImage
							src={headerAvatarUrl}
							crossOrigin="anonymous"
						/>
					) : null}
					<AvatarFallback>{headerTitle.trim().charAt(0).toUpperCase() || "?"}</AvatarFallback>
				</Avatar>
				<h1 className="min-w-0 flex-1 truncate text-base font-semibold">{headerTitle}</h1>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("chatItemMenuTrigger")}
							>
								<MoreHorizontalIcon />
							</Button>
						}
					/>
					<ChatDropdownMenuContent
						chat={chat}
						currentUserId={currentUserId}
						blocked={blocked}
						onAction={dialogHost.openChatDialog}
					/>
				</DropdownMenu>
			</header>
			<div className="h-px shrink-0 bg-border/50" />
			<div className="relative flex min-h-0 flex-1 flex-col">
				{renderList()}
				{showScrollToBottomFab ? (
					<ScrollToBottomFab
						count={affordance.unseenCount}
						onClick={scrollToBottom}
					/>
				) : null}
			</div>
			{/* Arrival announcements. The stable role="log" container with a KEYED inner span is what makes a
			repeat arrival from the same sender re-announce: the child is removed and re-inserted, which is
			the additions semantics role="log" defines — a bare changing text node with an identical string
			would be skipped. The adjacent TypingIndicator is also aria-live="polite"; two sibling polite
			regions interleave in the AT queue by design, neither preempts. */}
			<div
				role="log"
				aria-live="polite"
				className="sr-only"
			>
				{announcement !== null ? (
					<span key={announcement.seq}>
						{t("chatNewMessageAnnouncement", { count: announcement.count, name: announcement.name })}
					</span>
				) : null}
			</div>
			<TypingIndicator
				chatUuid={chatUuid}
				currentUserId={currentUserId}
			/>
			<Composer
				chat={chat}
				messages={messages}
				nonConfirmedUuids={nonConfirmedUuids}
				sender={sender}
				onSent={() => {
					stickBottomRef.current = true
					suppressNextArrivalRef.current = true
				}}
			/>
			{dialogHost.renderActiveDialog()}
		</div>
	)
}
