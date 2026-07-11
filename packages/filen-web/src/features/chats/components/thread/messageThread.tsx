import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { MoreHorizontalIcon } from "lucide-react"
import type { Chat } from "@filen/sdk-rs"
import { useChatMessages, loadOlderChatMessages } from "@/features/chats/queries/chatMessages"
import { buildThreadRows, computeScrollAfterPrepend } from "@/features/chats/components/thread/thread.logic"
import { dayKind, formatFullDate } from "@/features/chats/lib/time"
import { chatDisplayName, isChatUndecryptable } from "@/features/chats/lib/sort"
import { MessageRow } from "@/features/chats/components/thread/messageRow"
import { ChatDropdownMenuContent } from "@/features/chats/components/chatMenu"
import { useChatDialogHost } from "@/features/chats/hooks/useChatDialogHost"
import { useAccountQuery } from "@/queries/account"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// Estimates for the virtualizer's first pass; real heights come from measureElement (message rows vary in
// height with content). A day separator is a single fixed pill.
const DAY_ROW_ESTIMATE = 44
const MESSAGE_ROW_ESTIMATE = 56
// Load older when the user scrolls within this many px of the top.
const TOP_THRESHOLD = 120

function DaySeparator({ timestamp }: { timestamp: bigint }) {
	const { t } = useTranslation("chats")
	const kind = dayKind(timestamp)
	const label = kind === "today" ? t("chatDayToday") : kind === "yesterday" ? t("chatDayYesterday") : formatFullDate(timestamp)

	return (
		<div className="flex items-center justify-center py-2">
			<span className="rounded-full bg-muted px-3 py-0.5 text-[11px] font-medium text-muted-foreground">{label}</span>
		</div>
	)
}

// Read-only conversation thread (D3 dense grouped flat rows). Messages ascend (oldest→newest); the list is
// virtualized (@tanstack/react-virtual — the app's own virtualizer, notesSidebar's convention) and opens
// pinned to the bottom (newest). Scrolling to the top loads one older page via loadOlderChatMessages
// (prepend + dedupe) with scroll-position preservation. NO composer — a disabled placeholder strip keeps
// the layout honest until the send wave lands. The header's ⋮ trigger hosts the conversation menu
// (rename/mute/participants/leave/delete + the explicit "mark as read" entry) — the ONLY place this wave
// wires markChatRead: never auto-fired on mount (synthesis §1g/§3.6 — old-web's explicit-mark model, not
// mobile's own screen-open trigger).
export function MessageThread({ chat }: { chat: Chat }) {
	const { t } = useTranslation("chats")
	const chatUuid = chat.uuid
	const accountQuery = useAccountQuery()
	const currentUserId = accountQuery.data?.id
	const messagesQuery = useChatMessages(chatUuid)
	const messages = messagesQuery.data ?? []
	const dialogHost = useChatDialogHost({ currentUuid: chatUuid })

	const scrollRef = useRef<HTMLDivElement | null>(null)
	const [loadingOlder, setLoadingOlder] = useState(false)
	// Per-chat pagination bookkeeping (instance state in refs — React Compiler owns memoization).
	const hasMoreRef = useRef(true)
	const lastCursorRef = useRef<bigint | null>(null)
	const initialScrollChatRef = useRef<string | null>(null)
	// Set at load-older trigger time so the post-prepend layout effect can restore the viewport.
	const restoreRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null)

	const rows = buildThreadRows(messages)

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: index => (rows[index]?.kind === "day" ? DAY_ROW_ESTIMATE : MESSAGE_ROW_ESTIMATE),
		overscan: 8,
		getItemKey: index => rows[index]?.key ?? index
	})

	// Reset pagination when the selected conversation changes — a fresh chat may have older history and its
	// own bottom-anchor.
	useEffect(() => {
		hasMoreRef.current = true
		lastCursorRef.current = null
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

	async function handleScroll(): Promise<void> {
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
								) : (
									<MessageRow
										chat={chat}
										message={row.message}
										showHeader={row.showHeader}
										currentUserId={currentUserId}
									/>
								)}
							</div>
						)
					})}
				</div>
			</div>
		)
	}

	const headerTitle = isChatUndecryptable(chat)
		? t("chatUndecryptable")
		: currentUserId !== undefined
			? chatDisplayName(chat, currentUserId)
			: chat.uuid

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 items-center gap-2.5 px-5 py-4">
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
						onAction={dialogHost.openChatDialog}
					/>
				</DropdownMenu>
			</header>
			<div className="h-px shrink-0 bg-border/50" />
			{renderList()}
			{/* Disabled composer placeholder — the read-only wave renders the strip so the layout matches the
			    eventual composer, but nothing sends yet (send lands in a later wave). */}
			<div className="shrink-0 p-3">
				<div className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2.5 text-sm text-muted-foreground">
					<span className="flex-1 truncate">{t("chatComposerPlaceholder")}</span>
					<span className="shrink-0 text-xs">{t("chatComposerUnavailable")}</span>
				</div>
			</div>
			{dialogHost.renderActiveDialog()}
		</div>
	)
}
