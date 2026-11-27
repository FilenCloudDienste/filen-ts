import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import type { Options } from "react-hotkeys-hook"
import { defaultRangeExtractor, useVirtualizer, type Range, type VirtualItem } from "@tanstack/react-virtual"
import { useShallow } from "zustand/shallow"
import { SearchIcon, MessagesSquareIcon, SquarePenIcon, ChevronDownIcon } from "lucide-react"
import type { Chat } from "@filen/sdk-rs"
import { cn, type BlockedUsers } from "@filen/shared"
import { useChats } from "@/features/chats/queries/chats"
import { useAccountQuery } from "@/queries/account"
import {
	buildChatList,
	chatsInExpandedSections,
	chatsWithoutBlockedOneOnOne,
	filterChats,
	selectedChatUuidFromPath,
	staleChatSelectionUuids,
	CHAT_SECTIONS,
	type ChatListItem,
	type ChatSection
} from "@/features/chats/components/chatsSidebar.logic"
import { toggleChatSection, useCollapsedChatSections } from "@/features/chats/lib/sidebarSections"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { aggregateChatSelectionFlags, selectableChatsForSelectAll } from "@/features/chats/lib/selectionFlags"
import { chatHasUnread } from "@/features/chats/lib/unread.logic"
import { chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import { adjacentChatUuid, adjacentUnreadChatUuid, chatCommandTargets } from "@/features/chats/lib/keyboard.logic"
import { runMarkChatRead, runMarkChatsRead, runSetChatMuted, runSetChatsMuted } from "@/features/chats/lib/directActions"
import { useChatsSelectionStore } from "@/features/chats/store/useChatsSelectionStore"
import { useChatsListSelection } from "@/features/chats/hooks/useChatsListSelection"
import { ChatRow, type ChatRowProps } from "@/features/chats/components/chatRow"
import { ChatsBulkActionBar } from "@/features/chats/components/chatsBulkActionBar"
import { applyOfflineGate, chatMenuActions, type ChatActionDialogKind, type ChatActionId } from "@/features/chats/components/chatMenu.logic"
import { chatBulkActions, isChatBulkActionOfflineDisabled } from "@/features/chats/components/chatsBulkActionBar.logic"
import { useChatDialogHost } from "@/features/chats/hooks/useChatDialogHost"
import { useIsSidebarPanelVisible } from "@/features/shell/lib/sidebarPanelVisibility"
import { ResizableSidebarPanel } from "@/features/shell/components/sidebarPanel"
import { useIsOnline } from "@/lib/useIsOnline"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import type { ListPointerSelection } from "@/lib/useListPointerSelection"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { Kbd } from "@/lib/keymap/kbd"
import { LoadingState } from "@/components/loadingState"
import { ListFilterInput } from "@/components/listFilterInput"
import { SidebarNotice } from "@/components/sidebarNotice"
import { BULK_BAR_MIN_SELECTION } from "@/components/selectionActionBar"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { multiSelectionRingUuids } from "@/lib/useListPointerSelection"

// Next/previous conversation also work in the message field (Slack's Alt+↑/↓): a chord the textarea has no use for.
const IN_COMPOSER: Options = { ...OUTSIDE_OVERLAYS, enableOnFormTags: ["option", "textarea"] }

// Fixed heights — the single virtualizer needs no measureElement pass (a row's name and one-line preview
// are pinned to a known height), same as notesSidebar's constant-height rows.
const CHAT_ROW_HEIGHT = 48
const SECTION_HEADER_HEIGHT = 32

const SECTION_LABEL_KEY = { direct: "chatsSectionDirect", groups: "chatsSectionGroups" } as const

// Contextual conversation list — the shell's sidebar slot when on /chats*. Same panel geometry as
// NotesSidebar/DriveSidebar (w-52, rounded-xl, borderless). A virtualized list in collapsible sections
// (direct messages, then groups) + client-side search, a "New chat" button opening the contact picker
// (createChatDialog.tsx via useChatDialogHost), and per-row menus (chatRow.tsx's own context/dropdown menu).
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
	const collapsed = useCollapsedChatSections()

	const [search, setSearch] = useState("")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const headerRef = useRef<HTMLDivElement | null>(null)

	const allChats = chatsQuery.data ?? []
	// A 1:1 whose sole other participant is blocked drops out of the list entirely (mobile parity); the
	// thread stays URL-reachable and fully tombstoned.
	const visibleChats = chatsWithoutBlockedOneOnOne(allChats, currentUserId, blocked)
	const rows = filterChats(visibleChats, search, currentUserId, t("chatJustYou"), blocked)
	const searching = search.trim().length > 0
	// The sectioned list, and the conversations on screen in its order: selection ranges, select all and the
	// next/previous keys all walk these, never a collapsed section's.
	const list = buildChatList(rows, collapsed, searching)
	const listChats = list.chats

	// The conversations a selection may hold: listed, and in a section that shows its rows.
	const selectableChats = chatsInExpandedSections(visibleChats, collapsed, searching)

	// Everything derived from visibleChats is built before the hooks below: the React Compiler drops the
	// memo scope of a value that is still mutable across a hook call.
	const chatsByUuid = new Map(selectableChats.map(chat => [chat.uuid, chat]))
	// Active ghost-selection purge (the effect below): the chats list is PUSH-FED (a conversationDeleted/
	// conversationParticipantLeft socket event, or another tab's delete/leave, can drop a chat with no
	// navigation involved), so the STORE itself — not just this render's liveSelectedChats view — must
	// drop a uuid the instant it stops existing, or a stale entry sits there indefinitely until the
	// sidebar next unmounts. Mirrors directoryListing.tsx's own selection purges: keyed on a
	// uuid-content signature (stable across unrelated re-renders, since `visibleChats` can be a new
	// array with unchanged content), not `visibleChats` itself, and the uuids are read back out of that
	// key rather than off the array — so the effect depends on exactly what it uses. The signature is
	// over the SELECTABLE set, so whatever takes a conversation out of it drops it from an active selection
	// too, with no chat being deleted: blocking someone (their 1:1 leaves the list), collapsing a section, ending
	// a search over a collapsed one, or a conversation moving into a collapsed section (a group down to one other
	// participant).
	const selectableChatUuidsSignature = selectableChats
		.map(chat => chat.uuid)
		.sort()
		.join(",")

	const rawSelectedChats = useChatsSelectionStore(useShallow(state => state.selectedChats))
	// LIVE (ghost-purged) selection: re-derived from the selectable conversations every render, so a
	// conversation removed from the account (elsewhere, or by another tab) or folded out of sight between
	// selection and dispatch is never targeted or counted towards the bulk bar's "2+ selected" threshold,
	// even for the render before the purge below lands.
	const liveSelectedChats: Chat[] = []
	for (const selected of rawSelectedChats) {
		const live = chatsByUuid.get(selected.uuid)

		if (live) {
			liveSelectedChats.push(live)
		}
	}
	// The ordered, currently-visible conversation set click-selection ranges walk (search-filtered, collapsed
	// sections left out) —
	// mirrors notesSidebar's own selection wiring. Clears on mount/unmount (see the hook's own doc
	// comment) rather than a resetKey, since chats has no secondary view mode to key a reset off.
	const selection = useChatsListSelection({ chats: listChats, selectionCount: liveSelectedChats.length })

	useEffect(() => {
		const toRemove = staleChatSelectionUuids(useChatsSelectionStore.getState().selectedChats, selectableChatUuidsSignature.split(","))

		if (toRemove.length > 0) {
			useChatsSelectionStore.getState().removeFromSelection(toRemove)
		}
	}, [selectableChatUuidsSignature])

	// Def in features/chats/lib/keymap.ts. Browser default for mod+a is "select all page text" — must
	// preventDefault or the native selection would visibly compete with the row selection. Scoped to the
	// conversation list (the returned ref): in the thread, Mod+A is the page's own text select-all. Stands
	// down under any open dialog or menu (OUTSIDE_OVERLAYS). Targets the conversations on screen (search-
	// filtered, collapsed sections left out) minus undecryptable ones — mirrors drive.selectAll/
	// notes.selectAll exactly. Both actions below are
	// additionally OFF while the panel is out of sight (drawer closed below the layout breakpoint): rows,
	// count and bulk bar all live inside this panel, so firing them there would swallow the browser's own
	// select-all and leave an invisible selection behind.
	const selectAllRef = useAction(
		"chats.selectAll",
		event => {
			event.preventDefault()
			useChatsSelectionStore.getState().setSelectedChats(selectableChatsForSelectAll(listChats))
		},
		{ ...OUTSIDE_OVERLAYS, enabled: panelVisible },
		[listChats]
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
			} else if (descriptor.id === "mute") {
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
			openAdjacent(adjacentChatUuid(listChats, selectedUuid, 1))
		},
		IN_COMPOSER,
		[listChats, selectedUuid]
	)

	useAction(
		"chats.previousChat",
		event => {
			event.preventDefault()
			openAdjacent(adjacentChatUuid(listChats, selectedUuid, -1))
		},
		IN_COMPOSER,
		[listChats, selectedUuid]
	)

	// Unread is derived on the key press only, never per render.
	useAction(
		"chats.nextUnread",
		event => {
			event.preventDefault()
			openAdjacent(adjacentUnreadChatUuid(listChats, selectedUuid, 1, hasUnread))
		},
		IN_COMPOSER,
		[listChats, selectedUuid, currentUserId, blocked]
	)

	useAction(
		"chats.previousUnread",
		event => {
			event.preventDefault()
			openAdjacent(adjacentUnreadChatUuid(listChats, selectedUuid, -1, hasUnread))
		},
		IN_COMPOSER,
		[listChats, selectedUuid, currentUserId, blocked]
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
					description={errorLabel(chatsQuery.error)}
					action={
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								void chatsQuery.refetch()
							}}
						>
							{t("common:tryAgain")}
						</Button>
					}
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

	// The conversations that wear the multi-selection ring, derived after every hook: the React Compiler reads a call as able
	// to mutate its arguments, which would stretch the selection's mutable range across the hooks and drop their memos.
	const liveSelectedUuids = multiSelectionRingUuids(
		liveSelectedChats.map(chat => chat.uuid),
		selectedUuid
	)

	return (
		<ResizableSidebarPanel
			module="chats"
			resizeLabel={t("chatsSidebarResize")}
		>
			<div
				ref={headerRef}
				className="flex items-center gap-1.5 p-3"
			>
				<h2 className="sr-only">{t("chatsSidebarTitle")}</h2>
				<ListFilterInput
					value={search}
					onChange={setSearch}
					placeholder={t("chatsSearch")}
					ariaLabel={t("chatsSearch")}
					wrapperClassName="min-w-0 flex-1 app-region-no-drag"
				/>
				<TooltipIconButton
					disabled={!isOnline}
					label={t("chatsSidebarNewChat")}
					title={t("common:offlineActionDisabled")}
					shortcut={<Kbd action="chats.newChat" />}
					className="app-region-no-drag"
					onClick={() => {
						dialogHost.openCreateChatDialog()
					}}
				>
					<SquarePenIcon />
				</TooltipIconButton>
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
					className="flex flex-1 scrollbar-gutter-stable flex-col overflow-y-auto px-1.5 pb-3 app-region-pane"
				>
					<ChatsVirtualList
						items={list.items}
						headerIndexes={list.headerIndexes}
						searching={searching}
						scrollElement={scrollElement}
						fallback={renderFallback()}
						label={t("chatsListLabel")}
						sectionLabels={{ direct: t(SECTION_LABEL_KEY.direct), groups: t(SECTION_LABEL_KEY.groups) }}
						onToggleSection={toggleChatSection}
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

export interface ChatsVirtualListProps {
	items: ChatListItem[]
	headerIndexes: number[]
	// Every section shows expanded while searching, so its header cannot fold it.
	searching: boolean
	scrollElement: HTMLDivElement | null
	// Rendered instead of the list (loading, error, empty) while non-null.
	fallback: ReactNode
	label: string
	sectionLabels: Readonly<Record<ChatSection, string>>
	onToggleSection: (section: ChatSection) => void
	selectedUuid: string
	liveSelectedUuids: ReadonlySet<string>
	currentUserId: bigint | undefined
	blocked: BlockedUsers
	onAction: (kind: ChatActionDialogKind, chat: Chat) => void
	onPointerSelect: ListPointerSelection["handlePointerSelect"]
	onToggleSelect: ListPointerSelection["toggleAt"]
}

// A section's disclosure: a plain <button> with its own aria-expanded, controlling the section's listbox while
// there is one.
// The label is its own element so the listbox is named by the section alone.
function ChatSectionHeader({
	label,
	labelId,
	listboxId,
	expanded,
	disabled,
	onToggle
}: {
	label: string
	labelId: string
	// The section's listbox, while it is rendered.
	listboxId: string | undefined
	expanded: boolean
	disabled: boolean
	onToggle: () => void
}) {
	return (
		<button
			type="button"
			aria-expanded={expanded}
			aria-controls={listboxId}
			disabled={disabled}
			onClick={onToggle}
			className="flex h-full w-full items-end gap-1 rounded-md px-1 pb-1.5 text-left text-xs leading-4 font-medium text-muted-foreground focus-ring-row transition-colors outline-none app-region-no-drag enabled:hover:text-foreground"
		>
			<ChevronDownIcon
				aria-hidden="true"
				className={cn("mb-px size-3.5 shrink-0 transition-transform", !expanded && "-rotate-90")}
			/>
			<span
				id={labelId}
				className="min-w-0 truncate"
			>
				{label}
			</span>
		</button>
	)
}

type ChatListCallbacks = Pick<ChatsVirtualListProps, "onAction" | "onPointerSelect" | "onToggleSelect">

interface RowHandlerCache {
	onAction: ChatRowProps["onAction"]
	rowAt: (index: number) => Pick<ChatRowProps, "onPointerSelect" | "onLongPress">
	setLatest: (callbacks: ChatListCallbacks) => void
}

// Identity-stable row handlers for the memoized ChatRow: built in the uncompiled list host below, fresh closures would
// re-render every mounted row on each range change. Each handler is bound to its index once and calls the newest
// callbacks when it runs (set after every commit, so before any event can reach a row).
function createRowHandlerCache(initial: ChatListCallbacks): RowHandlerCache {
	let latest = initial
	const byIndex = new Map<number, Pick<ChatRowProps, "onPointerSelect" | "onLongPress">>()

	return {
		onAction: (kind, chat) => {
			latest.onAction(kind, chat)
		},
		rowAt: index => {
			let handlers = byIndex.get(index)

			if (handlers === undefined) {
				handlers = {
					onPointerSelect: (event, pointerType) => latest.onPointerSelect(index, event, pointerType),
					onLongPress: () => {
						latest.onToggleSelect(index)
					}
				}

				byIndex.set(index, handlers)
			}

			return handlers
		},
		setLatest: callbacks => {
			latest = callbacks
		}
	}
}

// Owns the virtualizer, which opts its host out of the React Compiler and re-renders it on every range
// change while scrolling; split out so ChatsSidebar itself compiles and those renders stay here. Mounted in
// every state, so the virtualizer lives exactly as long as the sidebar.
//
// One virtualizer over the flat item list, rendered as a listbox per section: each listbox is a static box,
// so its absolutely positioned options still lay out against the shared list container. Headers stay
// mounted however far the list scrolls, as each names its listbox.
export function ChatsVirtualList({
	items,
	headerIndexes,
	searching,
	scrollElement,
	fallback,
	label,
	sectionLabels,
	onToggleSection,
	selectedUuid,
	liveSelectedUuids,
	currentUserId,
	blocked,
	onAction,
	onPointerSelect,
	onToggleSelect
}: ChatsVirtualListProps) {
	const baseId = useId()
	const [rowHandlers] = useState(() => createRowHandlerCache({ onAction, onPointerSelect, onToggleSelect }))

	useLayoutEffect(() => {
		rowHandlers.setLatest({ onAction, onPointerSelect, onToggleSelect })
	})

	// Memoized by hand (useVirtualizer opts this component out of the React Compiler): the virtualizer
	// recomputes its window whenever the extractor changes.
	const rangeExtractor = useCallback(
		(range: Range) => {
			const indexes = defaultRangeExtractor(range)
			const missing = headerIndexes.filter(index => !indexes.includes(index))

			return missing.length === 0 ? indexes : [...missing, ...indexes].sort((a, b) => a - b)
		},
		[headerIndexes]
	)

	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: index => (items[index]?.kind === "header" ? SECTION_HEADER_HEIGHT : CHAT_ROW_HEIGHT),
		overscan: 10,
		getItemKey: index => items[index]?.key ?? index,
		rangeExtractor
	})

	if (fallback !== null) {
		return fallback
	}

	const virtualItems = virtualizer.getVirtualItems()

	function renderSection(section: ChatSection): ReactNode {
		const listboxId = `${baseId}-${section}`
		const labelId = `${listboxId}-label`
		let headerRow: { virtualRow: VirtualItem; expanded: boolean } | null = null
		const options: ReactNode[] = []

		for (const virtualRow of virtualItems) {
			const item = items[virtualRow.index]

			if (item?.section !== section) {
				continue
			}

			if (item.kind === "header") {
				headerRow = { virtualRow, expanded: item.expanded }

				continue
			}

			const { chat, index } = item
			const handlers = rowHandlers.rowAt(index)

			options.push(
				// Presentational: this wrapper only positions the row, and a generic container between
				// listbox and option breaks the owned-element relationship.
				<div
					key={virtualRow.key}
					role="presentation"
					className="absolute top-0 left-0 w-full"
					style={positionStyle(virtualRow, CHAT_ROW_HEIGHT)}
				>
					<ChatRow
						chat={chat}
						selected={chat.uuid === selectedUuid}
						multiSelected={liveSelectedUuids.has(chat.uuid)}
						posInSet={item.posInSet}
						setSize={item.setSize}
						currentUserId={currentUserId}
						blocked={blocked}
						onAction={rowHandlers.onAction}
						onPointerSelect={handlers.onPointerSelect}
						onLongPress={handlers.onLongPress}
					/>
				</div>
			)
		}

		if (headerRow === null) {
			return null
		}

		// A listbox only while it has options: a collapsed section's (or one whose rows are all scrolled out of the
		// window) would be an empty listbox, so the header then controls nothing.
		const listbox = options.length > 0

		return (
			<Fragment key={section}>
				<div
					className="absolute top-0 left-0 w-full"
					style={positionStyle(headerRow.virtualRow, SECTION_HEADER_HEIGHT)}
				>
					<ChatSectionHeader
						label={sectionLabels[section]}
						labelId={labelId}
						listboxId={listbox ? listboxId : undefined}
						expanded={headerRow.expanded}
						disabled={searching}
						onToggle={() => {
							onToggleSection(section)
						}}
					/>
				</div>
				{listbox ? (
					<div
						id={listboxId}
						role="listbox"
						aria-multiselectable="true"
						aria-labelledby={labelId}
					>
						{options}
					</div>
				) : null}
			</Fragment>
		)
	}

	return (
		<div
			role="group"
			aria-label={label}
			className="relative w-full"
			style={{ height: virtualizer.getTotalSize() }}
		>
			{CHAT_SECTIONS.map(renderSection)}
		</div>
	)
}

function positionStyle(virtualRow: VirtualItem, height: number): CSSProperties {
	return { height, transform: `translateY(${String(virtualRow.start)}px)` }
}
