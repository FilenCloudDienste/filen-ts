import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useRouterState } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { SearchIcon, XIcon, MessagesSquareIcon, PlusIcon } from "lucide-react"
import { useChats } from "@/features/chats/queries/chats"
import { useAccountQuery } from "@/queries/account"
import { filterChats } from "@/features/chats/components/chatsSidebar.logic"
import { ChatRow } from "@/features/chats/components/chatRow"
import { useChatDialogHost } from "@/features/chats/hooks/useChatDialogHost"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

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

// Compact centered notice sized for the narrow sidebar (mirrors notesSidebar's SidebarNotice).
function SidebarNotice({ icon, title, description }: { icon: ReactNode; title: string; description?: string }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
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
	const { t } = useTranslation("chats")
	const pathname = useRouterState({ select: state => state.location.pathname })
	const selectedUuid = selectedUuidFromPath(pathname)

	const chatsQuery = useChats()
	const accountQuery = useAccountQuery()
	const currentUserId = accountQuery.data?.id
	const dialogHost = useChatDialogHost({ currentUuid: selectedUuid })

	const [search, setSearch] = useState("")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

	const allChats = chatsQuery.data ?? []
	const rows = filterChats(allChats, search, currentUserId)
	const searching = search.trim().length > 0

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollElement,
		estimateSize: () => CHAT_ROW_HEIGHT,
		overscan: 10,
		getItemKey: index => rows[index]?.uuid ?? index
	})

	function renderBody(): ReactNode {
		if (chatsQuery.isPending) {
			return (
				<div className="flex flex-1 items-center justify-center py-8">
					<Spinner className="size-5 text-muted-foreground" />
				</div>
			)
		}

		if (chatsQuery.isError) {
			return (
				<SidebarNotice
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
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(virtualRow => {
					const chat = rows[virtualRow.index]

					if (chat === undefined) {
						return null
					}

					return (
						<div
							key={virtualRow.key}
							className="absolute top-0 left-0 w-full"
							style={{ height: CHAT_ROW_HEIGHT, transform: `translateY(${String(virtualRow.start)}px)` }}
						>
							<ChatRow
								chat={chat}
								selected={chat.uuid === selectedUuid}
								currentUserId={currentUserId}
								onAction={dialogHost.openChatDialog}
							/>
						</div>
					)
				})}
			</div>
		)
	}

	return (
		<aside
			// Geometry identical to DriveSidebar/NotesSidebar — the shell's contextual panel slot. Drag region
			// is Electron plumbing, inert in a plain browser; interactive descendants opt back out.
			className="hidden w-52 shrink-0 flex-col rounded-xl bg-sidebar app-region-drag md:flex"
		>
			<div className="flex flex-col gap-2 p-3">
				<div className="flex items-center justify-between gap-2">
					<h2 className="truncate px-1 text-[15px] font-semibold">{t("chatsSidebarTitle")}</h2>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("chatsSidebarNewChat")}
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
							className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 [&_svg]:size-3.5"
						>
							<XIcon />
						</button>
					) : null}
				</div>
			</div>

			<div
				ref={setScrollElement}
				className="flex flex-1 flex-col overflow-y-auto px-1.5 pb-3"
			>
				{renderBody()}
			</div>
			{dialogHost.renderActiveDialog()}
		</aside>
	)
}
