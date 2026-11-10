import { useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import type { Options } from "react-hotkeys-hook"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useShallow } from "zustand/shallow"
import { SearchIcon, MessagesSquareIcon, PlusIcon } from "lucide-react"
import type { Chat } from "@filen/sdk-rs"
import type { BlockedUsers } from "@filen/shared"
import { useChats } from "@/features/chats/queries/chats"
import { useAccountQuery } from "@/queries/account"
import {
	chatsWithoutBlockedOneOnOne,
	filterChats,
	selectedChatUuidFromPath,
	staleChatSelectionUuids
} from "@/features/chats/components/chatsSidebar.logic"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { aggregateChatSelectionFlags, selectableChatsForSelectAll } from "@/features/chats/lib/selectionFlags"
import { chatHasUnread } from "@/features/chats/lib/unread.logic"
import { chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import { adjacentChatUuid, adjacentUnreadChatUuid, chatCommandTargets } from "@/features/chats/lib/keyboard.logic"
import { runMarkChatRead, runMarkChatsRead, runSetChatMuted, runSetChatsMuted } from "@/features/chats/lib/directActions"
import { useChatsSelectionStore } from "@/features/chats/store/useChatsSelectionStore"
import { useChatsListSelection } from "@/features/chats/hooks/useChatsListSelection"
import { ChatRow } from "@/features/chats/components/chatRow"
import { ChatsBulkActionBar } from "@/features/chats/components/chatsBulkActionBar"
import { applyOfflineGate, chatMenuActions, type ChatActionDialogKind, type ChatActionId } from "@/features/chats/components/chatMenu.logic"
import { chatBulkActions, isChatBulkActionOfflineDisabled } from "@/features/chats/components/chatsBulkActionBar.logic"
import { useChatDialogHost } from "@/features/chats/hooks/useChatDialogHost"
import { useIsSidebarPanelVisible } from "@/features/shell/lib/sidebarPanelVisibility"
import { ResizableSidebarPanel } from "@/features/shell/components/sidebarPanel"
import { useIsOnline } from "@/lib/useIsOnline"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import type { ListPointerSelection } from "@/lib/useListPointerSelection"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { ListFilterInput } from "@/components/listFilterInput"
import { SidebarNotice } from "@/components/sidebarNotice"
import { BULK_BAR_MIN_SELECTION } from "@/components/selectionActionBar"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

// Next/previous conversation also work in the message field (Slack's Alt+↑/↓): a chord the textarea has no use for.
const IN_COMPOSER: Options = { ...OUTSIDE_OVERLAYS, enableOnFormTags: ["option", "textarea"] }

// Fixed row height — the single virtualizer needs no measureElement pass (the name line and the two-line
// preview clamp are pinned to a known height), same as notesSidebar's constant-height rows.
const CHAT_ROW_HEIGHT = 72

// Contextual conversation list — the shell's sidebar slot when on /chats*. Same panel geometry as
// NotesSidebar/DriveSidebar (w-52, rounded-xl, borderless). A virtualized list + client-side search, a
// "New chat" button opening the contact picker (createChatDialog.tsx via useChatDialogHost), and per-row
// menus (chatRow.tsx's own context/dropdown menu).
export function ChatsSidebar() {
	const { t } = useTranslation(["chats", "common"])
	const isOnline = useIsOnline()
	const panelVisible = useIsSidebarPanelVisible()
	const navigate = useNavigate()
	const pathname = useRouterState({ select: state => state.location.pathname })
	const selectedUuid = selectedChatUuidFromPath(pathname)

	const chatsQuery = useChats()
	const accountQuery = useAccountQuery()
	const currentUserId = accountQuery.data?.id
	// One enabled read for every list surface: it feeds each row's preview, unread count, menu and the
	// bulk bar by prop, so no row opens an observer of its own. Must stay inside the component that
	// renders the rows.
	const blocked = useBlockedUsers(true)
	const dialogHost = useChatDialogHost()

	const [search, setSearch] = useState("")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const headerRef = useRef<HTMLDivElement | null>(null)

	const allChats = chatsQuery.data ?? []
	// A 1:1 whose sole other participant is blocked drops out of the list entirely (mobile parity); the
	// thread stays URL-reachable and fully tombstoned.
	const visibleChats = chatsWithoutBlockedOneOnOne(allChats, currentUserId, blocked)
	const rows = filterChats(visibleChats, search, currentUserId, t("chatJustYou"), blocked)
	const searching = search.trim().length > 0

	// Everything derived from visibleChats is built before the hooks below: the React Compiler drops the
	// memo scope of a value that is still mutable across a hook call.
	const chatsByUuid = new Map(visibleChats.map(chat => [chat.uuid, chat]))
	// Active ghost-selection purge (the effect below): the chats list is PUSH-FED (a conversationDeleted/
	// conversationParticipantLeft socket event, or another tab's delete/leave, can drop a chat with no
	// navigation involved), so the STORE itself — not just this render's liveSelectedChats view — must
	// drop a uuid the instant it stops existing, or a stale entry sits there indefinitely until the
	// sidebar next unmounts. Mirrors directoryListing.tsx's own selection purges: keyed on a
	// uuid-content signature (stable across unrelated re-renders, since `visibleChats` can be a new
	// array with unchanged content), not `visibleChats` itself, and the uuids are read back out of that
	// key rather than off the array — so the effect depends on exactly what it uses. The signature is
	// over the VISIBLE set, so blocking someone drops their 1:1 from an active selection too — list
	// membership can change with no chat being deleted.
	const visibleChatUuidsSignature = visibleChats
		.map(chat => chat.uuid)
		.sort()
		.join(",")

	const rawSelectedChats = useChatsSelectionStore(useShallow(state => state.selectedChats))
	// LIVE (ghost-purged) selection: re-derived from the current chats query every render, so a
	// conversation removed from the account (elsewhere, or by another tab) between selection and
	// dispatch is never targeted or counted towards the bulk bar's "2+ selected" threshold.
	const liveSelectedChats: Chat[] = []
	for (const selected of rawSelectedChats) {
		const live = chatsByUuid.get(selected.uuid)

		if (live) {
			liveSelectedChats.push(live)
		}
	}
	const liveSelectedUuids = new Set(liveSelectedChats.map(chat => chat.uuid))
	// The ordered, currently-visible conversation set click-selection ranges walk (search-filtered) —
	// mirrors notesSidebar's own selection wiring. Clears on mount/unmount (see the hook's own doc
	// comment) rather than a resetKey, since chats has no secondary view mode to key a reset off.
	const selection = useChatsListSelection({ chats: rows, selectionCount: liveSelectedChats.length })

	useEffect(() => {
		const toRemove = staleChatSelectionUuids(useChatsSelectionStore.getState().selectedChats, visibleChatUuidsSignature.split(","))

		if (toRemove.length > 0) {
			useChatsSelectionStore.getState().removeFromSelection(toRemove)
		}
	}, [visibleChatUuidsSignature])

	// Def in features/chats/lib/keymap.ts. Browser default for mod+a is "select all page text" — must
	// preventDefault or the native selection would visibly compete with the row selection. Scoped to the
	// conversation list (the returned ref): in the thread, Mod+A is the page's own text select-all. Stands
	// down under any open dialog or menu (OUTSIDE_OVERLAYS). Targets `rows` (already search-filtered) minus
	// undecryptable ones — mirrors drive.selectAll/notes.selectAll exactly. Both actions below are
	// additionally OFF while the panel is out of sight (drawer closed below the layout breakpoint): rows,
	// count and bulk bar all live inside this panel, so firing them there would swallow the browser's own
	// select-all and leave an invisible selection behind.
	const selectAllRef = useAction(
		"chats.selectAll",
		event => {
			event.preventDefault()
			useChatsSelectionStore.getState().setSelectedChats(selectableChatsForSelectAll(rows))
		},
		{ ...OUTSIDE_OVERLAYS, enabled: panelVisible },
		[rows]
	)

	// Def in features/chats/lib/keymap.ts. No preventDefault — bare Escape has no disruptive browser
	// default. Stands down under an open dialog or menu, whose own Escape closes it.
	useAction(
		"chats.clearSelection",
		() => {
			useChatsSelectionStore.getState().clearSelectedChats()
		},
		{ ...OUTSIDE_OVERLAYS, enabled: panelVisible }
	)

	// One conversation through its menu's own gates (chatMenuActions plus the offline gate), several through the bulk
	// bar's, so a key never does what the menu or the bar would refuse. Delete falls back to Leave, as the menu swaps
	// them by ownership.
	//
	// The targets: the selection, only while the panel showing it is in sight, else the open conversation (from the full
	// list: a 1:1 with a blocked participant is open by URL but not listed). Resolved at the key press, so no render
	// hands the query's chats to a call between this component's hooks.
	function runChatCommand(ids: readonly ChatActionId[]): void {
		const chats = chatCommandTargets(
			panelVisible ? liveSelectedChats : [],
			allChats.find(chat => chat.uuid === selectedUuid)
		)
		const single = chats[0]

		if (single === undefined) {
			return
		}

		if (chats.length === 1) {
			const unread = chatHasUnread(single, currentUserId, blocked, chatMessagesQueryGet)
			const descriptor = applyOfflineGate(chatMenuActions(single, currentUserId, unread), isOnline).find(
				entry => ids.includes(entry.id) && entry.enabled !== false
			)

			if (descriptor === undefined) {
				return
			}

			if (descriptor.run === "dialog") {
				dialogHost.openChatDialog(descriptor.dialogKind, single)
			} else if (descriptor.id === "markRead") {
				runMarkChatRead(single)
			} else {
				runSetChatMuted(single, !single.muted)
			}

			return
		}

		const targets = [...chats]
		const flags = aggregateChatSelectionFlags(targets, currentUserId, blocked, chatMessagesQueryGet)
		const descriptor = chatBulkActions(flags).find(
			entry => ids.includes(entry.id) && !isChatBulkActionOfflineDisabled(entry.id, isOnline)
		)

		if (descriptor === undefined) {
			return
		}

		if (descriptor.run === "dialog") {
			dialogHost.openBulkDialog(descriptor.dialogKind, targets)
		} else if (descriptor.id === "markRead") {
			runMarkChatsRead(targets)
		} else {
			runSetChatsMuted(targets, !flags.includesMuted)
		}
	}

	function openAdjacent(uuid: string | null): void {
		if (uuid !== null) {
			void navigate({ to: "/chats/$uuid", params: { uuid } })
		}
	}

	function hasUnread(chat: Chat): boolean {
		return chatHasUnread(chat, currentUserId, blocked, chatMessagesQueryGet)
	}

	// Defs in features/chats/lib/keymap.ts. New chat is gated on the connectivity flag its button is disabled by.
	useAction(
		"chats.newChat",
		() => {
			if (isOnline) {
				dialogHost.openCreateChatDialog()
			}
		},
		OUTSIDE_OVERLAYS,
		[isOnline]
	)

	// The box lives in this panel, so the key is off while the panel is out of sight and the browser's find keeps it.
	useAction(
		"chats.search",
		event => {
			event.preventDefault()
			headerRef.current?.querySelector("input")?.focus()
		},
		{ ...OUTSIDE_OVERLAYS, enabled: panelVisible }
	)

	useAction(
		"chats.nextChat",
		event => {
			event.preventDefault()
			openAdjacent(adjacentChatUuid(rows, selectedUuid, 1))
		},
		IN_COMPOSER,
		[rows, selectedUuid]
	)

	useAction(
		"chats.previousChat",
		event => {
			event.preventDefault()
			openAdjacent(adjacentChatUuid(rows, selectedUuid, -1))
		},
		IN_COMPOSER,
		[rows, selectedUuid]
	)

	// Unread is derived on the key press only, never per render.
	useAction(
		"chats.nextUnread",
		event => {
			event.preventDefault()
			openAdjacent(adjacentUnreadChatUuid(rows, selectedUuid, 1, hasUnread))
		},
		IN_COMPOSER,
		[rows, selectedUuid, currentUserId, blocked]
	)

	useAction(
		"chats.previousUnread",
		event => {
			event.preventDefault()
			openAdjacent(adjacentUnreadChatUuid(rows, selectedUuid, -1, hasUnread))
		},
		IN_COMPOSER,
		[rows, selectedUuid, currentUserId, blocked]
	)

	useAction(
		"chats.rename",
		event => {
			event.preventDefault()
			runChatCommand(["rename"])
		},
		OUTSIDE_OVERLAYS,
		[liveSelectedChats, allChats, selectedUuid, panelVisible, isOnline, currentUserId, blocked]
	)

	useAction(
		"chats.participants",
		() => {
			runChatCommand(["participants"])
		},
		OUTSIDE_OVERLAYS,
		[liveSelectedChats, allChats, selectedUuid, panelVisible, isOnline, currentUserId, blocked]
	)

	useAction(
		"chats.markRead",
		() => {
			runChatCommand(["markRead"])
		},
		OUTSIDE_OVERLAYS,
		[liveSelectedChats, allChats, selectedUuid, panelVisible, isOnline, currentUserId, blocked]
	)

	useAction(
		"chats.mute",
		() => {
			runChatCommand(["mute"])
		},
		OUTSIDE_OVERLAYS,
		[liveSelectedChats, allChats, selectedUuid, panelVisible, isOnline, currentUserId, blocked]
	)

	// Scoped to the conversation list, like select all: in the thread, Delete is the focused message's. preventDefault:
	// Backspace still has a "go back" default in some engines.
	const deleteRef = useAction(
		"chats.deleteSelected",
		event => {
			event.preventDefault()
			runChatCommand(["delete", "leave"])
		},
		{ ...OUTSIDE_OVERLAYS, enabled: panelVisible },
		[liveSelectedChats, allChats, selectedUuid, panelVisible, isOnline, currentUserId, blocked]
	)

	// Null while listing; ChatsVirtualList renders the rows then.
	function renderFallback(): ReactNode {
		if (chatsQuery.isPending) {
			return <LoadingState size="md" />
		}

		if (chatsQuery.isError) {
			return (
				<SidebarNotice
					role="alert"
					icon={<MessagesSquareIcon />}
					title={t("chatsLoadError")}
				/>
			)
		}

		if (rows.length === 0) {
			return searching ? (
				<SidebarNotice
					icon={<SearchIcon />}
					title={t("chatsSearchEmptyTitle")}
					description={t("chatsSearchEmptyDescription")}
				/>
			) : (
				<SidebarNotice
					icon={<MessagesSquareIcon />}
					title={t("chatsEmptyTitle")}
					description={t("chatsEmptyDescription")}
				/>
			)
		}

		return null
	}

	return (
		<ResizableSidebarPanel
			module="chats"
			resizeLabel={t("chatsSidebarResize")}
		>
			<div
				ref={headerRef}
				className="flex flex-col gap-2 p-3"
			>
				<div className="flex items-center justify-between gap-2">
					<h2 className="truncate px-1 text-[15px] font-semibold">{t("chatsSidebarTitle")}</h2>
					<Button
						variant="ghost"
						size="icon-sm"
						disabled={!isOnline}
						aria-label={t("chatsSidebarNewChat")}
						title={!isOnline ? t("common:offlineActionDisabled") : undefined}
						className="app-region-no-drag"
						onClick={() => {
							dialogHost.openCreateChatDialog()
						}}
					>
						<PlusIcon />
					</Button>
				</div>

				<ListFilterInput
					value={search}
					onChange={setSearch}
					placeholder={t("chatsSearch")}
					ariaLabel={t("chatsSearch")}
					wrapperClassName="app-region-no-drag"
				/>
			</div>

			<div
				ref={element => {
					const releaseSelectAll = selectAllRef(element)
					const releaseDelete = deleteRef(element)

					return () => {
						releaseSelectAll?.()
						releaseDelete?.()
					}
				}}
				className="relative flex min-h-0 flex-1 flex-col"
			>
				<div
					ref={setScrollElement}
					className="flex flex-1 flex-col overflow-y-auto px-1.5 pb-3 app-region-pane"
				>
					<ChatsVirtualList
						rows={rows}
						scrollElement={scrollElement}
						fallback={renderFallback()}
						label={t("chatsListLabel")}
						selectedUuid={selectedUuid}
						liveSelectedUuids={liveSelectedUuids}
						currentUserId={currentUserId}
						blocked={blocked}
						onAction={dialogHost.openChatDialog}
						onPointerSelect={selection.handlePointerSelect}
						onToggleSelect={selection.toggleAt}
					/>
				</div>
				{/* Bottom-anchored floating selection bar — overlays the scroll container, replacing
					nothing in the header. Mirrors notesSidebar.tsx / directoryListing.tsx's own BulkActionBar
					placement. Shown at 2+ selected only — a single selection is just normal browsing. */}
				{liveSelectedChats.length >= BULK_BAR_MIN_SELECTION ? (
					<div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex justify-center">
						<ChatsBulkActionBar
							selectedChats={liveSelectedChats}
							currentUserId={currentUserId}
							blocked={blocked}
							onDialogAction={dialogHost.openBulkDialog}
						/>
					</div>
				) : null}
			</div>
			{dialogHost.renderActiveDialog()}
		</ResizableSidebarPanel>
	)
}

interface ChatsVirtualListProps {
	rows: Chat[]
	scrollElement: HTMLDivElement | null
	// Rendered instead of the list (loading, error, empty) while non-null.
	fallback: ReactNode
	label: string
	selectedUuid: string
	liveSelectedUuids: ReadonlySet<string>
	currentUserId: bigint | undefined
	blocked: BlockedUsers
	onAction: (kind: ChatActionDialogKind, chat: Chat) => void
	onPointerSelect: ListPointerSelection["handlePointerSelect"]
	onToggleSelect: ListPointerSelection["toggleAt"]
}

// Owns the virtualizer, which opts its host out of the React Compiler and re-renders it on every range
// change while scrolling; split out so ChatsSidebar itself compiles and those renders stay here. Mounted in
// every state, so the virtualizer lives exactly as long as the sidebar.
function ChatsVirtualList({
	rows,
	scrollElement,
	fallback,
	label,
	selectedUuid,
	liveSelectedUuids,
	currentUserId,
	blocked,
	onAction,
	onPointerSelect,
	onToggleSelect
}: ChatsVirtualListProps) {
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => CHAT_ROW_HEIGHT,
		overscan: 10,
		getItemKey: index => rows[index]?.uuid ?? index
	})

	if (fallback !== null) {
		return fallback
	}

	return (
		<div
			role="listbox"
			aria-multiselectable="true"
			aria-label={label}
			className="relative w-full"
			style={{ height: virtualizer.getTotalSize() }}
		>
			{virtualizer.getVirtualItems().map(virtualRow => {
				const chat = rows[virtualRow.index]

				if (chat === undefined) {
					return null
				}

				return (
					// Presentational: this wrapper only positions the row, and a generic container between
					// listbox and option breaks the owned-element relationship.
					<div
						key={virtualRow.key}
						role="presentation"
						className="absolute top-0 left-0 w-full"
						style={{ height: CHAT_ROW_HEIGHT, transform: `translateY(${String(virtualRow.start)}px)` }}
					>
						<ChatRow
							chat={chat}
							selected={chat.uuid === selectedUuid}
							multiSelected={liveSelectedUuids.has(chat.uuid)}
							beforeSelected={rows[virtualRow.index + 1]?.uuid === selectedUuid}
							posInSet={virtualRow.index + 1}
							setSize={rows.length}
							currentUserId={currentUserId}
							blocked={blocked}
							onAction={onAction}
							onPointerSelect={(event, pointerType) => onPointerSelect(virtualRow.index, event, pointerType)}
							onLongPress={() => {
								onToggleSelect(virtualRow.index)
							}}
						/>
					</div>
				)
			})}
		</div>
	)
}
