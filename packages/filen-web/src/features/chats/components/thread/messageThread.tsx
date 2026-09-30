import {
	useCallback,
	useEffect,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
	type FocusEvent,
	type KeyboardEvent,
	type ReactNode,
	type Ref
} from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import {
	defaultRangeExtractor,
	elementScroll,
	observeElementOffset,
	useVirtualizer,
	type Range,
	type VirtualizerOptions
} from "@tanstack/react-virtual"
import { MoreHorizontalIcon, ArrowDownIcon } from "lucide-react"
import type { Chat, ChatMessage } from "@filen/sdk-rs"
import type { BlockedUsers } from "@filen/shared"
import { useChatMessages, loadOlderChatMessages } from "@/features/chats/queries/chatMessages"
import {
	buildThreadRows,
	toBottomUpRows,
	countNewTailMessages,
	isScrollNearBottom,
	isScrollNearTop,
	scrollDistanceFromBottom,
	nextScrollAffordanceState,
	nextAnnouncement,
	announcementSubject,
	INITIAL_SCROLL_AFFORDANCE,
	type ThreadAnnouncement,
	type ThreadRow
} from "@/features/chats/components/thread/thread.logic"
import { composeMessageList } from "@/features/chats/lib/sync.logic"
import { useChatsInflightStore } from "@/features/chats/store/useChatsInflight"
import { Composer } from "@/features/chats/components/thread/composer"
import { TypingIndicator } from "@/features/chats/components/thread/typingIndicator"
import { setFocusedChat } from "@/features/chats/lib/focusedChat"
import { dayKind, formatFullDate } from "@/features/chats/lib/time"
import { chatTitle, chatAvatarUrl } from "@/features/chats/lib/sort"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { useRevealedBlockedMessages } from "@/features/chats/store/useRevealedBlockedMessages"
import { markChatRead } from "@/features/chats/lib/actions"
import { chatLastFocus } from "@/features/chats/lib/unread.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { MessageRow } from "@/features/chats/components/thread/messageRow"
import { ChatDropdownMenuContent } from "@/features/chats/components/chatMenu"
import { useChatDialogHost } from "@/features/chats/hooks/useChatDialogHost"
import { useAccountQuery } from "@/queries/account"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { UserAvatar } from "@/components/userAvatar"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { LoadingState } from "@/components/loadingState"

// Estimates for the virtualizer's first pass: a one-line row's real height, so most rows measure in
// without changing the total size. A size change mid-scroll cancels Chromium's animated keyboard scroll.
const DAY_ROW_ESTIMATE = 37
const HEADER_ROW_ESTIMATE = 59
const CONTINUATION_ROW_ESTIMATE = 24
// Load older when the user scrolls within this many px of the top.
const TOP_THRESHOLD = 120
// "At bottom" for the scroll-to-bottom affordance and tail-following.
const BOTTOM_THRESHOLD = 80

// The virtualizer's offset axis starts at the thread's bottom edge (thread.logic.ts's column-reverse
// geometry), the vertical twin of what the library does for RTL scrollLeft.
type ThreadVirtualizerOptions = VirtualizerOptions<HTMLDivElement, HTMLDivElement>

const observeOffsetFromBottom: ThreadVirtualizerOptions["observeElementOffset"] = (instance, callback) =>
	observeElementOffset(instance, (scrollTop, isScrolling) => {
		callback(scrollDistanceFromBottom(scrollTop), isScrolling)
	})

const scrollToOffsetFromBottom: ThreadVirtualizerOptions["scrollToFn"] = (offset, options, instance) => {
	elementScroll(0 - (offset + (options.adjustments ?? 0)), { ...options, adjustments: 0 }, instance)
}

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
		const outcome = await markChatRead(chat)
		setPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
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

// ThreadList calls useVirtualizer, so the compiler skips it and every virtualizer notify rebuilds its row
// elements. Compiled here, a row hands back its cached element and React skips the unchanged row subtree.
function ThreadRowContent({
	row,
	chat,
	currentUserId,
	blocked
}: {
	row: ThreadRow
	chat: Chat
	currentUserId: bigint | undefined
	blocked: BlockedUsers
}) {
	if (row.kind === "day") {
		return <DaySeparator timestamp={row.timestamp} />
	}

	if (row.kind === "unread") {
		return <UnreadDivider chat={chat} />
	}

	return (
		<MessageRow
			chat={chat}
			message={row.message}
			showHeader={row.showHeader}
			currentUserId={currentUserId}
			blocked={blocked}
		/>
	)
}

// Floating scroll-to-bottom pill — appears once the user has scrolled up AND at least one message has
// landed below the viewport since (thread.logic.ts's nextScrollAffordanceState). Click scrolls to bottom;
// the resulting scroll event clears it via the same reducer (no separate "dismiss" path).
function ScrollToBottomFab({ count, onClick }: { count: number; onClick: (pill: HTMLButtonElement) => void }) {
	const { t } = useTranslation("chats")

	return (
		<button
			type="button"
			onClick={event => {
				onClick(event.currentTarget)
			}}
			aria-label={t("chatScrollToBottom", { count })}
			className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-md"
		>
			<ArrowDownIcon className="size-3.5" />
			{t("chatNewMessagesCount", { count })}
		</button>
	)
}

export interface ThreadListHandle {
	// An own send snaps the view back to the newest message once its bubble lands (mobile parity), without
	// badging or announcing it.
	followOwnSend: () => void
}

interface ThreadListProps {
	ref: Ref<ThreadListHandle>
	chat: Chat
	// The thread header's title, which names the scroller for assistive tech.
	labelledBy: string
	// Ascending, as composed for the composer; `rows` is the same list bottom-up.
	messages: readonly ChatMessage[]
	rows: readonly ThreadRow[]
	isPending: boolean
	isError: boolean
	currentUserId: bigint | undefined
	blocked: BlockedUsers
}

// The scrolling half of the thread, remounted per conversation (MessageThread keys it) so no pagination,
// virtualizer or in-flight load-older state can carry from one chat into the next.
//
// Inverted like mobile's list, through the browser instead of a transform: the scroller is
// `flex-direction: column-reverse`, so its scroll origin is the bottom edge. It opens at the newest
// message with no scroll write, older pages and rows measuring in above the viewport never move what is
// on screen, rows growing at the bottom while the reader sits there stay pinned, and the composer growing
// shrinks the viewport from the top. The virtualizer runs on that same bottom-origin axis with rows
// bottom-up, so as the reader scrolls into history new rows measure in above the viewport and need no
// compensation. Rows are still emitted oldest-first so DOM, focus and reading order match the screen.
function ThreadList({ ref, chat, labelledBy, messages, rows, isPending, isError, currentUserId, blocked }: ThreadListProps) {
	const { t } = useTranslation("chats")
	const scrollRef = useRef<HTMLDivElement | null>(null)
	const [loadingOlder, setLoadingOlder] = useState(false)
	const hasMoreRef = useRef(true)
	const lastCursorRef = useRef<bigint | null>(null)
	// Tells the arrival effect below that the next tail growth is our own send: no badge, no announcement.
	const suppressNextArrivalRef = useRef(false)
	// The scroll-to-bottom pill's derived state (thread.logic.ts's pure reducer). `atBottom` doubles as
	// "following the tail": it drives the virtualizer's anchoring and the snap below.
	const [affordance, setAffordance] = useState(INITIAL_SCROLL_AFFORDANCE)
	const [announcement, setAnnouncement] = useState<ThreadAnnouncement | null>(null)
	// Full previous snapshot (not just `.length`) — countNewTailMessages needs the actual last message to
	// tell a tail arrival from a head prepend; length alone can't.
	const prevMessagesRef = useRef<readonly ChatMessage[]>([])
	const newestKey = rows[0]?.key
	const prevNewestKeyRef = useRef(newestKey)
	// The row holding keyboard focus stays mounted however far the thread scrolls: unmounting it would drop
	// focus to the body, and with it the keyboard's scroll target. Left set when focus moves out of the
	// thread, which costs one mounted row until focus next lands inside.
	const focusedRowRef = useRef<{ key: string; index: number } | null>(null)

	// Memoized by hand (useVirtualizer opts this component out of the React Compiler): the virtualizer
	// re-lays every row when its key function changes, so it must change with the rows and nothing else.
	const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows])

	const rangeExtractor = useCallback(
		(range: Range) => {
			const indexes = defaultRangeExtractor(range)
			const focused = focusedRowRef.current

			if (focused === null) {
				return indexes
			}

			// Rows shift by one per arrival, so the index taken at focus time is only a first guess.
			const index = rows[focused.index]?.key === focused.key ? focused.index : rows.findIndex(row => row.key === focused.key)
			const first = indexes[0]
			const last = indexes.at(-1)

			if (index === -1 || first === undefined || last === undefined || (index >= first && index <= last)) {
				return indexes
			}

			focused.index = index

			return index < first ? [index, ...indexes] : [...indexes, index]
		},
		[rows]
	)

	const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: index => {
			const row = rows[index]

			if (row?.kind !== "message") {
				return DAY_ROW_ESTIMATE
			}

			return row.showHeader ? HEADER_ROW_ESTIMATE : CONTINUATION_ROW_ESTIMATE
		},
		overscan: 8,
		getItemKey,
		rangeExtractor,
		observeElementOffset: observeOffsetFromBottom,
		scrollToFn: scrollToOffsetFromBottom,
		// Following the tail, a new message simply enters at offset 0. Scrolled up, the library keeps the row
		// under the reader's eye in place when rows are inserted or removed below it.
		anchorTo: affordance.atBottom ? "start" : "end"
	})

	useImperativeHandle(
		ref,
		() => ({
			followOwnSend: () => {
				suppressNextArrivalRef.current = true
				setAffordance(INITIAL_SCROLL_AFFORDANCE)
			}
		}),
		[]
	)

	// Grow the pill's count when messages land at the TAIL while the user is scrolled up (thread.logic.ts's
	// reducer no-ops this while at bottom). Keyed off countNewTailMessages, not raw length growth: a
	// loadOlderChatMessages prepend also grows `messages.length`, and that must NOT inflate this count.
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

		// Whole-batch derivation (thread.logic.ts): a refetch can land several messages from several senders
		// in one write, and self/blocked senders are dropped from both the count and the name there.
		const subject = announcementSubject(messages, newTailCount, currentUserId, blocked)

		if (subject !== null) {
			setAnnouncement(prev => nextAnnouncement(prev, subject.count, subject.name))
		}

		// The pill's count deliberately still includes blocked arrivals — it names nobody, and splitting
		// its count from the row list would make it lie about how far the thread has grown.
		setAffordance(prev => nextScrollAffordanceState(prev, { kind: "messagesArrived", count: newTailCount }))
	}, [messages, currentUserId, blocked])

	// A reader who is following but sits a few px above the bottom (or an own send from anywhere) would
	// otherwise keep the new message just out of view. At offset 0 the layout already shows it, so the
	// usual arrival writes nothing. Gated on the newest row changing, never on `atBottom` flipping, so
	// scrolling back near the bottom is not yanked.
	useLayoutEffect(() => {
		if (prevNewestKeyRef.current === newestKey) {
			return
		}

		prevNewestKeyRef.current = newestKey

		const el = scrollRef.current

		if (el !== null && affordance.atBottom && el.scrollTop !== 0) {
			el.scrollTop = 0
		}
	}, [newestKey, affordance.atBottom])

	function scrollToBottom(pill: HTMLButtonElement): void {
		const el = scrollRef.current

		if (el === null) {
			return
		}

		// The pill unmounts once the view reaches the bottom; focus it held moves to the thread, not the body.
		if (document.activeElement === pill) {
			el.focus({ preventScroll: true })
		}

		el.scrollTop = 0
	}

	// Home and End jump instead of animating: rows measuring in during the browser's animated scroll change
	// the scroller's size, which cancels it part way in Chromium. Keys from a portaled menu or dialog opened
	// by a row bubble here through React, but are not the thread's.
	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		const el = event.currentTarget

		if (
			(event.key !== "Home" && event.key !== "End") ||
			event.defaultPrevented ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey ||
			!(event.target instanceof Node) ||
			!el.contains(event.target)
		) {
			return
		}

		event.preventDefault()
		el.scrollTop = event.key === "End" ? 0 : 0 - el.scrollHeight
	}

	function handleFocus(event: FocusEvent<HTMLDivElement>): void {
		const el = event.currentTarget
		const target = event.target

		if (!el.contains(target)) {
			return
		}

		const row = target === el ? null : target.closest<HTMLElement>("[data-index]")
		const index = row === null ? -1 : Number(row.dataset["index"])
		const key = rows[index]?.key

		focusedRowRef.current = key === undefined ? null : { key, index }
	}

	async function loadOlder(): Promise<void> {
		if (loadingOlder || !hasMoreRef.current) {
			return
		}

		const oldest = messages[0]

		if (oldest === undefined || lastCursorRef.current === oldest.sentTimestamp) {
			// Same oldest cursor as the last attempt → no distinct older history to pull; stop retriggering.
			return
		}

		lastCursorRef.current = oldest.sentTimestamp
		setLoadingOlder(true)

		let pageLength: number | null

		try {
			pageLength = (await loadOlderChatMessages(chat, oldest.sentTimestamp)).length
		} catch {
			pageLength = null
		}

		setLoadingOlder(false)

		if (pageLength === null) {
			// Release the cursor so the next scroll near the top retries instead of paging staying off.
			lastCursorRef.current = null
		} else if (pageLength === 0) {
			hasMoreRef.current = false
		}
	}

	// Recomputes bottom-proximity on every scroll (the reducer returns `prev` unchanged for a redundant
	// event, so a scroll that changes nothing costs no render), and pages in older history near the top.
	function handleScroll(): void {
		const el = scrollRef.current

		if (el === null) {
			return
		}

		const atBottom = isScrollNearBottom(el.scrollTop, BOTTOM_THRESHOLD)

		setAffordance(prev => nextScrollAffordanceState(prev, { kind: "scroll", atBottom }))

		if (isScrollNearTop(el.scrollTop, el.scrollHeight, el.clientHeight, TOP_THRESHOLD)) {
			void loadOlder()
		}
	}

	function renderList(): ReactNode {
		if (isPending) {
			return <LoadingState size="lg" />
		}

		if (isError) {
			return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t("chatThreadLoadError")}</div>
		}

		if (rows.length === 0) {
			return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t("chatThreadEmpty")}</div>
		}

		// overflow-anchor off: the virtualizer is the only thing that compensates the offset, so the
		// browser's own scroll anchoring must not correct the same change a second time.
		//
		// Focusable so a click anywhere in the thread focuses it, making it the keyboard's scroll target.
		// Without that the target is the clicked node: Firefox finds none in the rows' user-select: none, and
		// WebKit loses it once the virtualizer unmounts the clicked row.
		return (
			<div
				ref={scrollRef}
				role="region"
				aria-labelledby={labelledBy}
				tabIndex={0}
				onScroll={handleScroll}
				onKeyDown={handleKeyDown}
				onFocus={handleFocus}
				className="flex flex-1 flex-col-reverse overflow-y-auto focus-ring-row outline-none [overflow-anchor:none] focus-visible:ring-inset"
			>
				{/* First in the DOM, like it is on screen: order-1 lifts it above the rows in a column-reverse
				    box, and appearing there cannot move the bottom-anchored rows. */}
				{loadingOlder ? (
					<div className="order-1 flex shrink-0 items-center justify-center py-2">
						<Spinner
							className="size-4 text-muted-foreground"
							aria-label={t("chatLoadingOlder")}
						/>
					</div>
				) : null}
				<div
					className="relative w-full shrink-0"
					style={{ height: virtualizer.getTotalSize() }}
				>
					{virtualizer
						.getVirtualItems()
						.toReversed()
						.map(virtualRow => {
							const row = rows[virtualRow.index]

							if (row === undefined) {
								return null
							}

							return (
								<div
									key={virtualRow.key}
									data-index={virtualRow.index}
									ref={virtualizer.measureElement}
									className="absolute bottom-0 left-0 w-full"
									style={{ transform: `translateY(${String(0 - virtualRow.start)}px)` }}
								>
									<ThreadRowContent
										row={row}
										chat={chat}
										currentUserId={currentUserId}
										blocked={blocked}
									/>
								</div>
							)
						})}
				</div>
			</div>
		)
	}

	const showScrollToBottomFab = !affordance.atBottom && affordance.unseenCount > 0

	return (
		<>
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
						{announcement.name !== null
							? t("chatNewMessageAnnouncement", { count: announcement.count, name: announcement.name })
							: t("chatNewMessagesMixedAnnouncement", { count: announcement.count })}
					</span>
				) : null}
			</div>
		</>
	)
}

// Conversation thread (dense grouped flat rows): header, the bottom-anchored message list (ThreadList),
// typing indicator and composer. Scrolling to the top loads one older page via loadOlderChatMessages. The
// composer routes every send through the outbox; an own send jumps the view back to the bottom. The
// header's ⋮ trigger hosts the conversation menu (rename/mute/participants/leave/delete + the explicit
// "mark as read" entry) — one of two places markChatRead is wired (chatMenu.tsx's row context menu is the
// other): never auto-fired on mount — old-web's explicit-mark model, not mobile's own screen-open trigger.
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
	const threadListRef = useRef<ThreadListHandle | null>(null)
	const titleId = useId()

	// Built here rather than in ThreadList: this component is compiled, so the rows are only rebuilt when
	// the messages change, not on every virtualizer re-render while scrolling.
	const rows = toBottomUpRows(
		buildThreadRows(messages, currentUserId !== undefined ? { lastFocus: chatLastFocus(chat), currentUserId, blocked } : undefined)
	)

	// Revealed blocked messages reset per conversation, so re-entering one re-hides them.
	useEffect(() => {
		useRevealedBlockedMessages.getState().clear()
	}, [chatUuid])

	// Track the open conversation OUTSIDE React so the socket handlers can gate derived-unread: a foreign
	// message landing in the chat the user is looking at must not flip it unread. Cleared on unmount /
	// chat change.
	useEffect(() => {
		setFocusedChat(chatUuid)

		return () => {
			setFocusedChat(null)
		}
	}, [chatUuid])

	const headerTitle = chatTitle(chat, currentUserId, t("chatUndecryptable"), t("chatJustYou"))
	const headerAvatarUrl = chatAvatarUrl(chat, currentUserId)

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 items-center gap-2.5 px-5 py-4">
				<UserAvatar
					src={headerAvatarUrl}
					name={headerTitle}
					className="size-8 shrink-0"
				/>
				<h1
					id={titleId}
					className="min-w-0 flex-1 truncate text-base font-semibold"
				>
					{headerTitle}
				</h1>
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
			<ThreadList
				key={chatUuid}
				ref={threadListRef}
				chat={chat}
				labelledBy={titleId}
				messages={messages}
				rows={rows}
				isPending={messagesQuery.isPending}
				isError={messagesQuery.isError}
				currentUserId={currentUserId}
				blocked={blocked}
			/>
			<TypingIndicator
				chatUuid={chatUuid}
				currentUserId={currentUserId}
			/>
			<Composer
				chat={chat}
				messages={messages}
				nonConfirmedUuids={nonConfirmedUuids}
				onSent={() => {
					threadListRef.current?.followOwnSend()
				}}
			/>
			{dialogHost.renderActiveDialog()}
		</div>
	)
}
