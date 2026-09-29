import { useState, type ReactElement, type ReactNode } from "react"
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
	SunIcon,
	MoonIcon,
	SettingsIcon,
	KeyboardIcon,
	LogOutIcon,
	UserIcon,
	CircleHelpIcon,
	type LucideIcon
} from "lucide-react"
import { formatBytesPerSecond } from "@filen/shared"
import { cn } from "@filen/shared"
import { DEFAULT_CONTACTS_SECTION_FILTER } from "@/features/contacts/components/contactsList.logic"
import { flushOutboxes, performLogout } from "@/features/shell/lib/performLogout"
import { useHasUnsyncedWork } from "@/features/shell/hooks/useUnsyncedWork"
import { logoutConfirmBodyKey } from "@/features/shell/hooks/useUnsyncedWork.logic"
import { useChatsUnreadCount } from "@/features/chats/hooks/useChatsUnreadCount"
import { useContactRequestsQuery } from "@/features/contacts/queries/contacts"
import { useAccountQuery } from "@/queries/account"
import { useHasActiveTransfers, useSpeedSampleAging, useTransfersAggregate } from "@/features/transfers/store/useTransfersStore"
import { shouldShowTransfersAggregate } from "@/features/transfers/screens/transfers.logic"
import { Logo } from "@/features/shell/components/logo"
import { useRailReorder } from "@/features/shell/hooks/useRailReorder"
import { DEFAULT_RAIL_ORDER, railEntryActive, type RailEntryId } from "@/features/shell/lib/railOrder.logic"
import { saveRailOrder, useRailOrderQuery } from "@/features/shell/queries/railOrder"
import { SidebarDrawerTrigger } from "@/features/shell/components/sidebarDrawer"
import { useTheme } from "@/providers/themeProvider"
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
import { useAction } from "@/lib/keymap/useAction"
import { isAnyDialogOpen } from "@/lib/keymap/dialogGuard"
import { Kbd } from "@/lib/keymap/kbd"

// Rail section slot: the active section rides a white chip (soft shadow); inactive glyphs are plain
// muted marks on the canvas that tint on hover. No borders — the chip and hover fills carry the
// state entirely. Reused by every real section entry (Drive, Contacts, Transfers) so they stay
// visually identical.
function railItemClass(active: boolean): string {
	return cn(
		// app-region-no-drag: every rail item is a real click target inside the rail's own drag region
		// (see IconRail's <nav> below).
		"flex size-9 items-center justify-center rounded-lg focus-ring transition-colors outline-none app-region-no-drag [&_svg]:size-[22px] [&_svg]:shrink-0",
		active ? "bg-rail-chip text-rail-chip-foreground shadow-sm" : "text-muted-foreground hover:bg-rail-hover hover:text-foreground"
	)
}

interface RailEntryProps {
	active: boolean
	// Tooltips stay closed while an entry is being dragged.
	reordering: boolean
}

// Help destination ships later (the real support URL is a pending product decision) — rendered inert
// like the pending module entries below, so the rail slot and its affordance already exist.
function HelpEntry() {
	const { t } = useTranslation()

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						aria-disabled="true"
						aria-label={t("help")}
						className={cn(railItemClass(false), "text-muted-foreground/70")}
					>
						<CircleHelpIcon />
					</button>
				}
			/>
			<TooltipContent side="right">
				{t("help")}
				<span className="text-background/60">· {t("comingSoon")}</span>
			</TooltipContent>
		</Tooltip>
	)
}

function AccountMenu() {
	const { t } = useTranslation(["common", "auth"])
	const navigate = useNavigate()
	const { toggleTheme } = useTheme()
	const accountQuery = useAccountQuery()
	const hasUnsyncedWork = useHasUnsyncedWork()
	const hasActiveTransfers = useHasActiveTransfers()
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [shortcutsOpen, setShortcutsOpen] = useState(false)
	const [pending, setPending] = useState(false)

	// Same guard as the rail's route-nav actions (useNavigateAction): an open dialog owns the
	// keyboard, so the overlay never stacks on top of one.
	useAction("app.openShortcuts", () => {
		if (isAnyDialogOpen()) {
			return
		}

		setShortcutsOpen(true)
	})

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
							aria-label={t("account")}
							className="rounded-full app-region-no-drag"
						>
							<Avatar size="sm">
								<AvatarFallback>
									<UserIcon className="size-4" />
								</AvatarFallback>
							</Avatar>
						</Button>
					}
				/>
				<DropdownMenuContent
					side="right"
					align="end"
					sideOffset={8}
					className="min-w-52"
				>
					<DropdownMenuGroup>
						{/* Base UI MenuGroupLabel requires an enclosing group. */}
						<DropdownMenuLabel className="truncate">{accountQuery.data?.email ?? t("account")}</DropdownMenuLabel>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						{/* Settings moved off the rail into the account menu (rail footer is now collapse + avatar
						    only). */}
						<DropdownMenuItem
							onClick={() => {
								void navigate({ to: "/settings/account" })
							}}
						>
							<SettingsIcon />
							{t("settings")}
							<span className="ml-auto">
								<Kbd action="app.openSettings" />
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
		</>
	)
}

// One section entry: a nav Link in a right-side tooltip. `ariaLabel` replaces `label` as the Link's name
// when a count is folded in; `tooltipExtra` trails the label in the tooltip; `children` overlay the icon.
// `relative` anchors the badge and overlays, so it is only added for entries that carry them.
interface RailLinkProps<TOptions = unknown> extends RailEntryProps {
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

// This used to be a Popover trigger showing a quick-glance panel, with a "See all" footer link
// to the real screen; the extra click/indirection was not worth it, so it is now a plain nav Link like
// every other rail entry, straight to /transfers. Also renders the aggregate {percent,
// speed} computeTransfersAggregate already computes (previously only activeCount was read anywhere):
// a slim progress sliver along the icon's own bottom edge for `percent`, and the live rolling-window
// `speed` folded into the tooltip text — mirrors mobile's floating pill's own speed+progress readout,
// condensed to fit this narrow rail slot instead of a separate persistent surface.
function TransfersEntry({ active, reordering }: RailEntryProps) {
	const { t } = useTranslation(["common", "transfers"])
	const { activeCount, percent, speed } = useTransfersAggregate()
	const showAggregate = shouldShowTransfersAggregate(activeCount)

	// Ticks in the always-mounted rail, not only on /transfers: a paused or stalled transfer writes
	// nothing more, so without the tick this tooltip would keep its last speed on every other screen.
	useSpeedSampleAging()

	return (
		<RailLink
			active={active}
			reordering={reordering}
			label={t("common:moduleTransfers")}
			ariaLabel={activeCount > 0 ? t("transfers:transfersActiveBadge", { count: activeCount }) : undefined}
			icon={ArrowDownUpIcon}
			linkOptions={{ to: "/transfers" }}
			badgeCount={activeCount}
			tooltipExtra={showAggregate ? <span className="text-background/60"> · {formatBytesPerSecond(speed)}</span> : null}
		>
			{showAggregate ? (
				<span
					aria-hidden="true"
					className="absolute inset-x-2 bottom-1 h-[3px] overflow-hidden rounded-full bg-foreground/20"
				>
					<span
						className="block h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
						style={{ width: `${String(percent)}%` }}
					/>
				</span>
			) : null}
		</RailLink>
	)
}

// Previously playlists only lived inside the now-playing popover's Playlists tab, unreachable without a
// playing queue — this entry (plus nowPlayingPanel.tsx dropping that tab) fixes that reachability gap.
function PlaylistsEntry({ active, reordering }: RailEntryProps) {
	const { t } = useTranslation("common")

	return (
		<RailLink
			active={active}
			reordering={reordering}
			label={t("modulePlaylists")}
			icon={ListMusicIcon}
			linkOptions={{ to: "/playlists" }}
		/>
	)
}

// Default order puts Photos next to Drive rather than beside Transfers/Playlists/Chats: photos is a
// derived VIEW over a directory the user picks from their own drive, not an independent module with
// its own storage the way playlists/transfers are.
function PhotosEntry({ active, reordering }: RailEntryProps) {
	const { t } = useTranslation("common")

	return (
		<RailLink
			active={active}
			reordering={reordering}
			label={t("modulePhotos")}
			icon={ImagesIcon}
			linkOptions={{ to: "/photos" }}
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

function SettingsEntry({ active, reordering }: RailEntryProps) {
	const { t } = useTranslation()

	return (
		<RailLink
			active={active}
			reordering={reordering}
			label={t("settings")}
			icon={SettingsIcon}
			linkOptions={{ to: "/settings/account" }}
		/>
	)
}

const RAIL_ENTRIES: Record<RailEntryId, (props: RailEntryProps) => ReactElement> = {
	drive: DriveEntry,
	photos: PhotosEntry,
	transfers: TransfersEntry,
	notes: NotesEntry,
	chats: ChatsEntry,
	playlists: PlaylistsEntry,
	contacts: ContactsEntry,
	settings: SettingsEntry
}

// Registered at module scope (default unassigned) — this only wires the LIVE combo, which starts as ""
// (react-hotkeys-hook's parser treats it as "never matches") and works the instant a user rebinds it,
// with no further code change. Guarded on isAnyDialogOpen() (dialogGuard.ts, the same shared Base UI
// signal themeProvider.tsx uses — this rail is mounted outside the drive feature's own isDialogOpen
// chain too) so a rebound combo can't navigate away out from under an open dialog/preview.
function useNavigateAction(id: string, to: "/settings/account" | "/transfers" | "/playlists" | "/photos"): void {
	const navigate = useNavigate()

	useAction(
		id,
		() => {
			if (isAnyDialogOpen()) {
				return
			}

			void navigate({ to })
		},
		undefined,
		[navigate, to]
	)
}

export function IconRail() {
	const { t } = useTranslation()
	const pathname = useRouterState({ select: state => state.location.pathname })
	const order = useRailOrderQuery().data ?? DEFAULT_RAIL_ORDER
	const { slotProps } = useRailReorder(order, saveRailOrder)

	useNavigateAction("app.openSettings", "/settings/account")
	useNavigateAction("app.openTransfers", "/transfers")
	useNavigateAction("app.openPlaylists", "/playlists")
	useNavigateAction("app.openPhotos", "/photos")

	return (
		<nav
			aria-label={t("appName")}
			// Drag region (Electron plumbing): a plain browser ignores -webkit-app-region entirely, so
			// this is inert weight everywhere else. Every interactive descendant below opts back out
			// with app-region-no-drag so it stays clickable. overflow-y-auto: the entry list is fixed-height
			// and can outgrow a short viewport (landscape phone); tooltips portal out, so a scroll container
			// here cannot clip them.
			className="flex w-12 shrink-0 flex-col items-center gap-1.5 overflow-y-auto py-1.5 app-region-drag"
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
			    it lifts and follows the pointer while the others slide to open its landing slot. */}
			<div className="flex flex-col items-center gap-1.5">
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
							/>
						</div>
					)
				})}
			</div>

			{/* Pinned footer — the rail's extensible utility slot list; future entries stack above the
			    account menu. */}
			<div className="mt-auto flex w-full flex-col items-center gap-1.5">
				<HelpEntry />
				<AccountMenu />
			</div>
		</nav>
	)
}
