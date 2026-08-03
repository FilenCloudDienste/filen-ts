import { Fragment, useEffect, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useRouterState } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useShallow } from "zustand/shallow"
import { SearchIcon, XIcon, MessagesSquareIcon, PlusIcon } from "lucide-react"
import type { Chat } from "@filen/sdk-rs"
import { useChats } from "@/features/chats/queries/chats"
import { useAccountQuery } from "@/queries/account"
import { chatsWithoutBlockedOneOnOne, filterChats, staleChatSelectionUuids } from "@/features/chats/components/chatsSidebar.logic"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { selectableChatsForSelectAll } from "@/features/chats/lib/selectionFlags"
import { useChatsSelectionStore } from "@/features/chats/store/useChatsSelectionStore"
import { useChatsListSelection } from "@/features/chats/hooks/useChatsListSelection"
import { ChatRow } from "@/features/chats/components/chatRow"
import { ChatsBulkActionBar } from "@/features/chats/components/chatsBulkActionBar"
import { useChatDialogHost } from "@/features/chats/hooks/useChatDialogHost"
import { useResizableSidebar } from "@/features/shell/hooks/useResizableSidebar"
import { useIsSidebarPanelVisible } from "@/features/shell/lib/sidebarPanelVisibility"
import { SidebarResizeHandle } from "@/features/shell/components/sidebarResizeHandle"
import { useIsOnline } from "@/lib/useIsOnline"
import { useAction } from "@/lib/keymap/useAction"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { ListSkeleton } from "@/components/listSkeleton"

// Fixed row height — the single virtualizer needs no measureElement pass (both lines are pinned to a known
// height), same as notesSidebar's constant-height rows.
const CHAT_ROW_HEIGHT = 60

// The URL owns the selected conversation: /chats/<uuid> is a selection key. The sidebar renders in the app
// shell (outside the chats route match), so it reads the raw pathname rather than route params. Empty at
// bare "/chats" (nothing selected).
function selectedUuidFromPath(pathname: string): string {
	const match = /^\/chats\/([^/]+)/.exec(pathname)

	return match?.[1] ?? ""
}

// Compact centered notice sized for the narrow sidebar (mirrors notesSidebar's SidebarNotice). `role`
// is opt-in so only the load-failure caller announces — an empty conversation list is not an error.
function SidebarNotice({ icon, title, description, role }: { icon: ReactNode; title: string; description?: string; role?: "alert" }) {
	return (
		<div
			role={role}
			className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
		>
			<div className="text-muted-foreground [&_svg]:size-6">{icon}</div>
			<p className="text-sm font-medium">{title}</p>
			{description !== undefined ? <p className="text-xs text-muted-foreground">{description}</p> : null}
		</div>
	)
}

// Contextual conversation list — the shell's sidebar slot when on /chats*. Same panel geometry as
// NotesSidebar/DriveSidebar (w-52, rounded-xl, borderless). A virtualized list + client-side search, a
// "New chat" button opening the contact picker (createChatDialog.tsx via useChatDialogHost), and per-row
// menus (chatRow.tsx's own context/dropdown menu).
export function ChatsSidebar() {
	const { t } = useTranslation(["chats", "common"])
	const isOnline = useIsOnline()
	const panelVisible = useIsSidebarPanelVisible()
	const resize = useResizableSidebar("chats")
	const pathname = useRouterState({ select: state => state.location.pathname })
	const selectedUuid = selectedUuidFromPath(pathname)

	const chatsQuery = useChats()
	const accountQuery = useAccountQuery()
	const currentUserId = accountQuery.data?.id
	// One enabled read for every list surface: it feeds each row's preview, unread count, menu and the
	// bulk bar by prop, so no row opens an observer of its own. Must stay inside the component that
	// renders the rows.
	const blocked = useBlockedUsers(true)
	const dialogHost = useChatDialogHost({ currentUuid: selectedUuid })

	const [search, setSearch] = useState("")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

	const allChats = chatsQuery.data ?? []
	// A 1:1 whose sole other participant is blocked drops out of the list entirely (mobile parity); the
	// thread stays URL-reachable and fully tombstoned.
	const visibleChats = chatsWithoutBlockedOneOnOne(allChats, currentUserId, blocked)
	const rows = filterChats(visibleChats, search, currentUserId, t("chatJustYou"), blocked)
	const searching = search.trim().length > 0

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollElement,
		estimateSize: () => CHAT_ROW_HEIGHT,
		overscan: 10,
		getItemKey: index => rows[index]?.uuid ?? index
	})

	// The ordered, currently-visible conversation set click-selection ranges walk (search-filtered) —
	// mirrors notesSidebar's own selection wiring. Clears on mount/unmount (see the hook's own doc
	// comment) rather than a resetKey, since chats has no secondary view mode to key a reset off.
	const selection = useChatsListSelection({ chats: rows })
	const rawSelectedChats = useChatsSelectionStore(useShallow(state => state.selectedChats))
	// LIVE (ghost-purged) selection: re-derived from the current chats query every render, so a
	// conversation removed from the account (elsewhere, or by another tab) between selection and
	// dispatch is never targeted or counted towards the bulk bar's "2+ selected" threshold.
	const chatsByUuid = new Map(visibleChats.map(chat => [chat.uuid, chat]))
	const liveSelectedChats: Chat[] = []
	for (const selected of rawSelectedChats) {
		const live = chatsByUuid.get(selected.uuid)

		if (live) {
			liveSelectedChats.push(live)
		}
	}
	const liveSelectedUuids = new Set(liveSelectedChats.map(chat => chat.uuid))

	// Active ghost-selection purge: the chats list is PUSH-FED (a conversationDeleted/
	// conversationParticipantLeft socket event, or another tab's delete/leave, can drop a chat with no
	// navigation involved), so the STORE itself — not just this render's liveSelectedChats view — must
	// drop a uuid the instant it stops existing, or a stale entry sits there indefinitely until the
	// sidebar next unmounts. Mirrors directoryListing.tsx's own search-result ghost purge: keyed on a
	// uuid-content signature (stable across unrelated re-renders, since `visibleChats` is a brand-new
	// array every render regardless of whether anything actually changed), not `visibleChats` itself. The
	// signature is over the VISIBLE set, so blocking someone drops their 1:1 from an active selection too
	// — list membership can change with no chat being deleted.
	const visibleChatUuidsSignature = visibleChats
		.map(chat => chat.uuid)
		.sort()
		.join(",")

	useEffect(() => {
		const toRemove = staleChatSelectionUuids(useChatsSelectionStore.getState().selectedChats, visibleChats)

		if (toRemove.length > 0) {
			useChatsSelectionStore.getState().removeFromSelection(toRemove)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the signature above, not visibleChats — see comment above
	}, [visibleChatUuidsSignature])

	// Def in features/chats/lib/keymap.ts. Browser default for mod+a is "select all page text" — must
	// preventDefault or the native selection would visibly compete with the row selection. Guarded on
	// dialogHost.isDialogOpen so a background Cmd+A can't select conversations behind an open dialog.
	// Targets `rows` (already search-filtered) minus undecryptable ones — mirrors drive.selectAll/
	// notes.selectAll exactly. Both actions below are additionally OFF while the panel is out of sight
	// (drawer closed below the layout breakpoint): rows, count and bulk bar all live inside this panel, so
	// firing them there would swallow the browser's own select-all and leave an invisible selection behind.
	useAction(
		"chats.selectAll",
		event => {
			if (dialogHost.isDialogOpen) {
				return
			}

			event.preventDefault()
			useChatsSelectionStore.getState().setSelectedChats(selectableChatsForSelectAll(rows))
		},
		{ enabled: panelVisible },
		[dialogHost.isDialogOpen, rows]
	)

	// Def in features/chats/lib/keymap.ts. No preventDefault — bare Escape has no disruptive browser
	// default. Guarded on dialogHost.isDialogOpen so Escape closes the dialog (its own onOpenChange
	// handling) without also clearing the background selection.
	useAction(
		"chats.clearSelection",
		() => {
			if (dialogHost.isDialogOpen) {
				return
			}

			useChatsSelectionStore.getState().clearSelectedChats()
		},
		{ enabled: panelVisible },
		[dialogHost.isDialogOpen]
	)

	function renderBody(): ReactNode {
		if (chatsQuery.isPending) {
			// Bar height mirrors CHAT_ROW_HEIGHT so the placeholder list has the rhythm of the real one.
			return (
				<ListSkeleton
					count={8}
					itemClassName="h-[60px] w-full rounded-xl"
					className="flex flex-col gap-1 px-1 pt-1"
				/>
			)
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

		return (
			<div
				role="listbox"
				aria-multiselectable="true"
				aria-label={t("chatsListLabel")}
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
								posInSet={virtualRow.index + 1}
								setSize={rows.length}
								currentUserId={currentUserId}
								blocked={blocked}
								onAction={dialogHost.openChatDialog}
								onPointerSelect={event => {
									selection.handlePointerSelect(virtualRow.index, event)
								}}
							/>
						</div>
					)
				})}
			</div>
		)
	}

	return (
		<Fragment>
			<aside
				// Geometry mirrors DriveSidebar/NotesSidebar (rounded-xl, borderless) — the shell's contextual
				// panel slot. Width is user-resizable (useResizableSidebar) — the inline style replaces the old
				// static w-52 utility, and a trailing drag-handle sibling (below) commits the new width;
				// max-w-full clamps a wide persisted width to whatever host it lands in (the shell row, or the
				// narrow-viewport drawer). Visibility is the shell's call, never this panel's — see
				// appShell.tsx. Drag region is Electron plumbing, inert in a plain browser; interactive
				// descendants opt back out.
				className="flex max-w-full shrink-0 flex-col rounded-xl bg-sidebar app-region-drag"
				style={{ width: resize.width }}
			>
				<div className="flex flex-col gap-2 p-3">
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

					<div className="relative app-region-no-drag">
						<SearchIcon
							aria-hidden="true"
							className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							type="search"
							aria-label={t("chatsSearch")}
							placeholder={t("chatsSearch")}
							value={search}
							onChange={event => {
								setSearch(event.target.value)
							}}
							onKeyDown={event => {
								if (event.key === "Escape" && search.length > 0) {
									event.preventDefault()
									setSearch("")
								}
							}}
							className="h-8 pr-8 pl-8"
						/>
						{search.length > 0 ? (
							<button
								type="button"
								aria-label={t("chatsSearchClear")}
								onClick={() => {
									setSearch("")
								}}
								className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground focus-ring outline-none hover:text-foreground [&_svg]:size-3.5"
							>
								<XIcon />
							</button>
						) : null}
					</div>
				</div>

				<div className="relative flex min-h-0 flex-1 flex-col">
					<div
						ref={setScrollElement}
						className="flex flex-1 flex-col overflow-y-auto px-1.5 pb-3"
					>
						{renderBody()}
					</div>
					{/* Bottom-anchored floating selection bar — overlays the scroll container, replacing
					nothing in the header. Mirrors notesSidebar.tsx / directoryListing.tsx's own BulkActionBar
					placement. Shown at 2+ selected only — a single selection is just normal browsing. */}
					{liveSelectedChats.length > 1 ? (
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
			</aside>
			<SidebarResizeHandle
				ariaLabel={t("chatsSidebarResize")}
				handle={resize}
			/>
		</Fragment>
	)
}
