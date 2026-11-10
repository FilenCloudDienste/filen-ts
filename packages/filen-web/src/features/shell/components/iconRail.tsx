import { useEffect, useState, type ReactElement, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate, useRouterState, type RegisteredRouter, type ValidateLinkOptions } from "@tanstack/react-router"
import {
	FolderClosedIcon,
	NotebookPenIcon,
	MessagesSquareIcon,
	UsersIcon,
	ArrowDownUpIcon,
	ListMusicIcon,
	ImagesIcon,
	ClapperboardIcon,
	SunIcon,
	MoonIcon,
	SettingsIcon,
	KeyboardIcon,
	LogOutIcon,
	UserIcon,
	FolderSyncIcon,
	HardDriveIcon,
	ImagePlayIcon,
	MonitorIcon,
	FileXIcon,
	type LucideIcon
} from "lucide-react"
import type { UserAccountSubs } from "@filen/sdk-rs"
import { cn } from "@filen/shared"
import { DEFAULT_CONTACTS_SECTION_FILTER } from "@/features/contacts/components/contactsList.logic"
import { flushOutboxes, performLogout } from "@/features/shell/lib/performLogout"
import { useHasUnsyncedWork } from "@/features/shell/hooks/useUnsyncedWork"
import { logoutConfirmBodyKey } from "@/features/shell/hooks/useUnsyncedWork.logic"
import { useChatsUnreadCount } from "@/features/chats/hooks/useChatsUnreadCount"
import { useContactRequestsQuery } from "@/features/contacts/queries/contacts"
import { useAccountQuery, useMasterKeysNotExported } from "@/queries/account"
import { useWithdrawalNotice } from "@/features/settings/hooks/useWithdrawalNotice"
import { WithdrawalDialog } from "@/features/settings/components/billing/withdrawalDialog"
import { RailStatusDot, RailTooltipDetail } from "@/features/shell/components/railProgressBar"
import { useHasActiveTransfers } from "@/features/transfers/store/useTransfersStore"
import { Logo } from "@/features/shell/components/logo"
import { useRailReorder } from "@/features/shell/hooks/useRailReorder"
import {
	DEFAULT_RAIL_ORDER,
	mergeRailOrder,
	railEntryActive,
	visibleRailOrder,
	type RailEntryId
} from "@/features/shell/lib/railOrder.logic"
import { saveRailOrder, useRailOrderQuery } from "@/features/shell/queries/railOrder"
import { SidebarDrawerTrigger } from "@/features/shell/components/sidebarDrawer"
import { AssistantToggle } from "@/features/assistant/components/assistantToggle"
import { RailGroup } from "@/features/shell/components/railGroup"
import { TransfersRing } from "@/features/shell/components/transfersRing"
import { railItemClass } from "@/features/shell/lib/railItem"
import { settingsRoute } from "@/features/shell/lib/railGroups.logic"
import { useSyncAggregate } from "@/features/sync/lib/syncStore"
import { useMountsAggregate } from "@/features/mounts/lib/mountsStore"
import { useTheme } from "@/providers/themeProvider"
import { desktopBridge, desktopPlatform } from "@/lib/desktop"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { ShortcutsDialog } from "@/lib/keymap/shortcutsDialog"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import { Kbd } from "@/lib/keymap/kbd"

// macOS desktop: the rail holds the native traffic lights.
const RAIL_HOLDS_TRAFFIC_LIGHTS = desktopPlatform() === "darwin"

// The bridge never appears or disappears mid-session.
const IS_DESKTOP = desktopBridge() !== undefined

interface RailEntryProps {
	active: boolean
	// Tooltips and flyouts stay closed while an entry is being dragged.
	reordering: boolean
	// A group marks the child it is in.
	pathname: string
}

const NO_SUBS: UserAccountSubs[] = []

function AccountMenu() {
	const { t } = useTranslation(["common", "auth", "settings"])
	const navigate = useNavigate()
	const { toggleTheme } = useTheme()
	const accountQuery = useAccountQuery()
	const keysNotExported = accountQuery.data?.didExportMasterKeys === false
	const hasUnsyncedWork = useHasUnsyncedWork()
	const hasActiveTransfers = useHasActiveTransfers()
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [shortcutsOpen, setShortcutsOpen] = useState(false)
	const [pending, setPending] = useState(false)
	const [withdrawOpen, setWithdrawOpen] = useState(false)
	// Withdrawal lives with web billing, never in the desktop app.
	const { now, notice: withdrawal } = useWithdrawalNotice(IS_DESKTOP ? NO_SUBS : (accountQuery.data?.subs ?? NO_SUBS))
	const withdrawUntil = withdrawal?.until

	// Same guard as the rail's route-nav actions (useNavigateAction): an open dialog or menu owns the
	// keyboard, so the overlay never stacks on top of one.
	useAction(
		"app.openShortcuts",
		() => {
			setShortcutsOpen(true)
		},
		OUTSIDE_OVERLAYS
	)

	async function handleSignOut(): Promise<void> {
		setPending(true)
		try {
			if (!(await performLogout())) {
				// Declined at the unsaved-preview prompt — don't leave this confirm sitting open behind an
				// already-answered dialog.
				setConfirmOpen(false)
			}
		} finally {
			// performLogout isolates every phase internally (log-and-continue) and never rejects; this
			// mirrors login-form's unconditional reset — harmless even though a successful sign-out
			// reloads the page shortly after.
			setPending(false)
		}
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="ghost"
							size="icon-lg"
							aria-label={
								withdrawUntil === undefined
									? t("account")
									: `${t("account")}, ${t("settings:settingsBillingWithdrawStatus", { date: withdrawUntil })}`
							}
							className="relative rounded-full app-region-no-drag"
						>
							<Avatar size="sm">
								<AvatarFallback>
									<UserIcon className="size-4" />
								</AvatarFallback>
							</Avatar>
							{withdrawUntil === undefined ? null : (
								<RailStatusDot
									dot="notice"
									className="absolute top-1 right-1 ring-2 ring-canvas"
								/>
							)}
						</Button>
					}
				/>
				<DropdownMenuContent
					side="right"
					align="end"
					sideOffset={8}
					className="min-w-52"
				>
					{withdrawUntil === undefined ? null : (
						<>
							<DropdownMenuGroup>
								<DropdownMenuItem
									className="text-warning-foreground focus:text-warning-foreground"
									onClick={() => {
										setWithdrawOpen(true)
									}}
								>
									<FileXIcon className="text-warning-foreground" />
									<span className="flex min-w-0 flex-col">
										<span>{t("settings:settingsBillingWithdraw")}</span>
										<span className="text-xs">
											{t("settings:settingsBillingWithdrawUntil", { date: withdrawUntil })}
										</span>
									</span>
								</DropdownMenuItem>
							</DropdownMenuGroup>
							<DropdownMenuSeparator />
						</>
					)}
					<DropdownMenuGroup>
						{/* Base UI MenuGroupLabel requires an enclosing group. */}
						<DropdownMenuLabel className="truncate">{accountQuery.data?.email ?? t("account")}</DropdownMenuLabel>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						{/* Settings is also a rail entry; this keeps it next to the account it belongs to. While the
						    master keys are not exported it leads to Security and says why, not by colour alone. */}
						<DropdownMenuItem
							onClick={() => {
								void navigate({ to: settingsRoute(keysNotExported) })
							}}
						>
							<SettingsIcon />
							{t("settings")}
							{keysNotExported && <span className="sr-only">{`, ${t("settings:settingsMasterKeysNotExportedStatus")}`}</span>}
							<span className="ml-auto flex items-center gap-2">
								{keysNotExported && <RailStatusDot dot="attention" />}
								<Kbd action="app.openSettings" />
							</span>
						</DropdownMenuItem>
						{/* The rail shows its transfers ring only while there are transfers; this keeps the screen
						    one click away when there are none. */}
						<DropdownMenuItem
							onClick={() => {
								void navigate({ to: "/transfers" })
							}}
						>
							<ArrowDownUpIcon />
							{t("moduleTransfers")}
							<span className="ml-auto">
								<Kbd action="app.openTransfers" />
							</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() => {
								setShortcutsOpen(true)
							}}
						>
							<KeyboardIcon />
							{t("shortcutsTitle")}
							<span className="ml-auto">
								<Kbd action="app.openShortcuts" />
							</span>
						</DropdownMenuItem>
						<DropdownMenuItem onClick={toggleTheme}>
							<SunIcon className="dark:hidden" />
							<MoonIcon className="hidden dark:block" />
							{t("toggleTheme")}
							<span className="ml-auto">
								<Kbd action="app.toggleTheme" />
							</span>
						</DropdownMenuItem>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="destructive"
						onClick={() => {
							// Anything still queued has until the confirm is answered to reach the server;
							// past that the wipe destroys it.
							flushOutboxes()
							setConfirmOpen(true)
						}}
					>
						<LogOutIcon />
						{t("signOut")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<ConfirmDialog
				open={confirmOpen}
				pending={pending}
				title={t("auth:logoutConfirmTitle")}
				body={t(`auth:${logoutConfirmBodyKey(hasUnsyncedWork, hasActiveTransfers)}`)}
				confirmLabel={t("signOut")}
				cancelLabel={t("cancel")}
				destructive
				onOpenChange={setConfirmOpen}
				onConfirm={() => {
					void handleSignOut()
				}}
			/>
			<ShortcutsDialog
				open={shortcutsOpen}
				onOpenChange={setShortcutsOpen}
			/>
			{IS_DESKTOP || accountQuery.data === undefined ? null : (
				<WithdrawalDialog
					open={withdrawOpen}
					account={accountQuery.data}
					now={now}
					subId={withdrawal?.sub.id}
					onOpenChange={setWithdrawOpen}
				/>
			)}
		</>
	)
}

// One section entry: a nav Link in a right-side tooltip. `ariaLabel` replaces `label` as the Link's name
// when a count is folded in; `tooltipExtra` trails the label in the tooltip; `children` overlay the icon.
// `relative` anchors the badge and overlays, so it is only added for entries that carry them.
interface RailLinkProps<TOptions = unknown> extends Omit<RailEntryProps, "pathname"> {
	label: string
	ariaLabel?: string | undefined
	icon: LucideIcon
	linkOptions: ValidateLinkOptions<RegisteredRouter, TOptions>
	badgeCount?: number
	tooltipExtra?: ReactNode
	children?: ReactNode
}

function RailLink<TOptions>(props: RailLinkProps<TOptions>): ReactElement
function RailLink({ active, reordering, label, ariaLabel, icon: Icon, linkOptions, badgeCount, tooltipExtra, children }: RailLinkProps) {
	return (
		<Tooltip disabled={reordering}>
			<TooltipTrigger
				render={
					<Link
						{...linkOptions}
						aria-current={active ? "page" : undefined}
						aria-label={ariaLabel ?? label}
						className={
							badgeCount === undefined && children === undefined
								? railItemClass(active)
								: cn(railItemClass(active), "relative")
						}
					>
						<Icon />
						{badgeCount !== undefined && badgeCount > 0 ? (
							// aria-hidden: the count is already folded into the Link's own aria-label — a labelled
							// element ignores descendant content for its accessible name, so a label here would be
							// dead weight, not a second announcement.
							<Badge
								aria-hidden="true"
								className="absolute -top-1 -right-1 h-4 min-w-4 justify-center rounded-full px-1 text-[10px] tabular-nums"
							>
								{badgeCount}
							</Badge>
						) : null}
						{children}
					</Link>
				}
			/>
			<TooltipContent side="right">
				{label}
				{tooltipExtra}
			</TooltipContent>
		</Tooltip>
	)
}

// Media groups the modules that view the drive's photos, videos and music; each child is the page it was.
function MediaEntry({ reordering, pathname }: RailEntryProps) {
	const { t } = useTranslation("common")

	return (
		<RailGroup
			group="media"
			label={t("moduleMedia")}
			icon={ImagePlayIcon}
			pathname={pathname}
			reordering={reordering}
			items={[
				{ id: "photos", label: t("modulePhotos"), icon: ImagesIcon, dot: null },
				{ id: "videos", label: t("moduleVideos"), icon: ClapperboardIcon, dot: null },
				{ id: "playlists", label: t("modulePlaylists"), icon: ListMusicIcon, dot: null }
			]}
		/>
	)
}

// Desktop app only: visibleRailOrder leaves it out of a browser's rail. Each child's dot: attention (a failed
// host, a pair in error, review or missing its directory, open issues; a failed mount or server) wins over
// work in progress. The aggregates select one string each, so progress pushes re-render nothing here.
function ComputerEntry({ reordering, pathname }: RailEntryProps) {
	const { t } = useTranslation(["common", "sync", "mounts"])
	const syncAggregate = useSyncAggregate()
	const mountsAggregate = useMountsAggregate()
	const syncDot = syncAggregate === "attention" ? "attention" : syncAggregate === "syncing" ? "busy" : null
	const mountsDot = mountsAggregate === "attention" ? "attention" : mountsAggregate === "uploading" ? "busy" : null

	return (
		<RailGroup
			group="computer"
			label={t("common:moduleComputer")}
			icon={MonitorIcon}
			pathname={pathname}
			reordering={reordering}
			items={[
				{
					id: "sync",
					label: t("common:moduleSync"),
					icon: FolderSyncIcon,
					dot: syncDot,
					statusLabel: syncDot === "attention" ? t("sync:railAttention") : syncDot === "busy" ? t("sync:railSyncing") : undefined
				},
				{
					id: "mounts",
					label: t("common:moduleMounts"),
					icon: HardDriveIcon,
					dot: mountsDot,
					statusLabel:
						mountsDot === "attention" ? t("mounts:railAttention") : mountsDot === "busy" ? t("mounts:railUploading") : undefined
				}
			]}
		/>
	)
}

function DriveEntry({ active, reordering }: RailEntryProps) {
	const { t } = useTranslation()

	return (
		<RailLink
			active={active}
			reordering={reordering}
			label={t("moduleDrive")}
			icon={FolderClosedIcon}
			linkOptions={{ to: "/drive/$", params: { _splat: "" } }}
		/>
	)
}

// Mounting the already-batched requests query here keeps the incoming-request badge current app-wide,
// not only on /contacts.
function ContactsEntry({ active, reordering }: RailEntryProps) {
	const { t } = useTranslation()
	const contactRequestsQuery = useContactRequestsQuery()
	const incomingRequestCount = contactRequestsQuery.status === "success" ? contactRequestsQuery.data.incoming.length : 0

	return (
		<RailLink
			active={active}
			reordering={reordering}
			label={t("moduleContacts")}
			ariaLabel={incomingRequestCount > 0 ? t("contactRequestsBadge", { count: incomingRequestCount }) : undefined}
			icon={UsersIcon}
			linkOptions={{ to: "/contacts", search: { section: DEFAULT_CONTACTS_SECTION_FILTER } }}
			badgeCount={incomingRequestCount}
		/>
	)
}

function NotesEntry({ active, reordering }: RailEntryProps) {
	const { t } = useTranslation()

	return (
		<RailLink
			active={active}
			reordering={reordering}
			label={t("moduleNotes")}
			icon={NotebookPenIcon}
			linkOptions={{ to: "/notes" }}
		/>
	)
}

// The badge counts unread messages across every chat, client-derived; the rail is always mounted with
// the authed shell, so this hook is also what keeps that count loaded whichever module is open.
function ChatsEntry({ active, reordering }: RailEntryProps) {
	const { t } = useTranslation()
	const currentUserId = useAccountQuery().data?.id
	const unreadChatsCount = useChatsUnreadCount(currentUserId)

	// The desktop shell shows the same count on the dock / taskbar; leaving the authed shell clears it.
	useEffect(() => {
		desktopBridge()?.app.setBadge(unreadChatsCount)
	}, [unreadChatsCount])

	useEffect(
		() => () => {
			desktopBridge()?.app.setBadge(0)
		},
		[]
	)

	return (
		<RailLink
			active={active}
			reordering={reordering}
			label={t("moduleChats")}
			ariaLabel={unreadChatsCount > 0 ? t("chatsUnreadBadge", { count: unreadChatsCount }) : undefined}
			icon={MessagesSquareIcon}
			linkOptions={{ to: "/chats" }}
			badgeCount={unreadChatsCount}
		/>
	)
}

// While the master keys are not exported the entry carries a dot, says so in its name and tooltip, and
// opens Security, where they are exported.
function SettingsEntry({ active, reordering }: RailEntryProps) {
	const { t } = useTranslation(["common", "settings"])
	const keysNotExported = useMasterKeysNotExported()
	const label = t("settings")

	if (!keysNotExported) {
		return (
			<RailLink
				active={active}
				reordering={reordering}
				label={label}
				icon={SettingsIcon}
				linkOptions={{ to: settingsRoute(false) }}
			/>
		)
	}

	const status = t("settings:settingsMasterKeysNotExportedStatus")

	return (
		<RailLink
			active={active}
			reordering={reordering}
			label={label}
			ariaLabel={t("railGroupWithStatus", { group: label, status })}
			icon={SettingsIcon}
			linkOptions={{ to: settingsRoute(true) }}
			tooltipExtra={<RailTooltipDetail>{status}</RailTooltipDetail>}
		>
			<RailStatusDot
				dot="attention"
				className="absolute top-1 right-1 ring-2 ring-canvas"
			/>
		</RailLink>
	)
}

const RAIL_ENTRIES: Record<RailEntryId, (props: RailEntryProps) => ReactElement> = {
	drive: DriveEntry,
	media: MediaEntry,
	notes: NotesEntry,
	chats: ChatsEntry,
	contacts: ContactsEntry,
	computer: ComputerEntry,
	settings: SettingsEntry
}

// Registered at module scope (default unassigned) — this only wires the LIVE combo, which starts as ""
// (react-hotkeys-hook's parser treats it as "never matches") and works the instant a user rebinds it,
// with no further code change. Stands down under any open dialog or menu (OUTSIDE_OVERLAYS) so a
// rebound combo can't navigate away out from under it.
function useNavigateAction(
	id: string,
	to: "/settings/account" | "/settings/security" | "/transfers" | "/playlists" | "/photos" | "/videos"
): void {
	const navigate = useNavigate()

	useAction(
		id,
		() => {
			void navigate({ to })
		},
		OUTSIDE_OVERLAYS,
		[navigate, to]
	)
}

// Whether the element's content is taller than its box. The box is sized to its content until it is capped, so
// a resize catches every flip but one: an entry added while the content exactly fills the cap, which
// `contentCount` covers.
function useOverflowsY(element: HTMLElement | null, contentCount: number): boolean {
	const [overflows, setOverflows] = useState(false)

	useEffect(() => {
		if (!element) {
			return
		}

		const observer = new ResizeObserver(() => {
			setOverflows(element.scrollHeight > element.clientHeight)
		})

		observer.observe(element)

		return () => {
			observer.disconnect()
		}
	}, [element, contentCount])

	return overflows
}

export function IconRail() {
	const { t } = useTranslation()
	const pathname = useRouterState({ select: state => state.location.pathname })
	const fullOrder = useRailOrderQuery().data ?? DEFAULT_RAIL_ORDER
	const order = visibleRailOrder(fullOrder, { desktop: IS_DESKTOP })
	const { slotProps } = useRailReorder(order, next => {
		saveRailOrder(mergeRailOrder(fullOrder, next))
	})
	const [entryList, setEntryList] = useState<HTMLDivElement | null>(null)
	const entriesScroll = useOverflowsY(entryList, order.length)

	const keysNotExported = useMasterKeysNotExported()

	useNavigateAction("app.openSettings", settingsRoute(keysNotExported))
	useNavigateAction("app.openTransfers", "/transfers")
	useNavigateAction("app.openPlaylists", "/playlists")
	useNavigateAction("app.openPhotos", "/photos")
	useNavigateAction("app.openVideos", "/videos")

	return (
		<nav
			aria-label={t("appName")}
			// Drag region (Electron plumbing): a plain browser ignores -webkit-app-region entirely, so
			// this is inert weight everywhere else. Every interactive descendant below opts back out
			// with app-region-no-drag so it stays clickable. On a short viewport the entry list below scrolls,
			// not the rail; overflow-y-auto here is only the browser fallback for a viewport too short for the
			// rail's fixed parts (landscape phone), which the desktop window's minimum height rules out.
			// macOS desktop: the native traffic lights sit at the top of the rail (see the shell's window
			// options), so the rail widens to hold them and the brand moves below them.
			className={cn(
				"flex shrink-0 flex-col items-center gap-1.5 overflow-y-auto app-region-drag",
				RAIL_HOLDS_TRAFFIC_LIGHTS ? "w-16 pt-6.5 pb-1.5" : "w-12 py-1.5"
			)}
		>
			<Link
				to="/drive/$"
				params={{ _splat: "" }}
				aria-label={t("moduleDrive")}
				className="mb-1.5 flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground focus-ring outline-none app-region-no-drag dark:bg-rail-chip dark:text-rail-chip-foreground"
			>
				<Logo className="size-5" />
			</Link>

			{/* Narrow viewports only (md:hidden): opens the drawer holding the current module's sidebar.
			    Sits with the section entries it reaches, below the brand. */}
			<SidebarDrawerTrigger className={railItemClass(false)} />

			{/* The section links, in the user's order. Drag one to move it (or Alt+Arrow on a focused one):
			    it lifts and follows the pointer while the others slide to open its landing slot.
			    The list shrinks first on a short viewport and scrolls only then, so a lifted entry is never clipped
			    otherwise. While it scrolls it is a pane: Chromium never clips a drag region to a scroll container,
			    so an entry scrolled out of view would keep its no-drag box over the drag strip above the rail.
			    The padding gives the edge entries' focus rings room inside the scroll box; the margin cancels it. */}
			<div
				ref={setEntryList}
				className={cn(
					"-my-1.5 flex min-h-0 w-full flex-col items-center gap-1.5 py-1.5",
					entriesScroll && "overflow-y-auto app-region-pane"
				)}
			>
				{order.map((id, index) => {
					const Entry = RAIL_ENTRIES[id]
					const { dragging, reordering, style, ...handlers } = slotProps(index)

					return (
						<div
							key={id}
							style={style}
							className={cn(
								"relative app-region-no-drag",
								reordering && !dragging && "transition-transform duration-150 ease-out",
								dragging && "z-10 cursor-grabbing *:bg-rail-chip *:text-rail-chip-foreground *:shadow-lg"
							)}
							{...handlers}
						>
							<Entry
								active={railEntryActive(id, pathname)}
								reordering={reordering}
								pathname={pathname}
							/>
						</div>
					)
				})}
			</div>

			{/* Pinned footer — the rail's extensible utility slot list; the transfers ring shows above it
			    only while there are transfers to list. */}
			<div className="mt-auto flex w-full flex-col items-center gap-1.5">
				<TransfersRing active={pathname === "/transfers"} />
				<AssistantToggle itemClass={railItemClass} />
				<AccountMenu />
			</div>
		</nav>
	)
}
