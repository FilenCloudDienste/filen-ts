import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import {
	FolderClosedIcon,
	NotebookPenIcon,
	MessagesSquareIcon,
	UsersIcon,
	ArrowDownUpIcon,
	SunIcon,
	MoonIcon,
	SettingsIcon,
	LogOutIcon,
	UserIcon,
	CircleHelpIcon
} from "lucide-react"
import { formatBytes } from "@filen/utils"
import { cn } from "@/lib/utils"
import { DEFAULT_CONTACTS_SECTION_FILTER } from "@/features/contacts/components/contactsList.logic"
import { performLogout } from "@/features/shell/lib/performLogout"
import { useChatsUnreadCount } from "@/features/chats/hooks/useChatsUnreadCount"
import { useContactRequestsQuery } from "@/features/contacts/queries/contacts"
import { useAccountQuery } from "@/queries/account"
import { useTransfersAggregate } from "@/features/transfers/store/useTransfersStore"
import { shouldShowTransfersAggregate } from "@/features/transfers/screens/transfers.logic"
import { Logo } from "@/features/shell/components/logo"
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
import { registerAction } from "@/lib/keymap/registry"
import { useAction } from "@/lib/keymap/useAction"
import { isAnyDialogOpen } from "@/lib/keymap/dialogGuard"
import { Kbd } from "@/lib/keymap/kbd"

// Registered at module scope (runs once per module evaluation — mirrors themeProvider.tsx's own
// "app.toggleTheme" registration right next to its useAction call below). Default UNASSIGNED
// ("" — react-hotkeys-hook's own combo parser accepts an empty string as "matches no key", verified
// against the installed package's parseHotkeys, so this never fires until a user rebinds it): the
// keyboard-first contract only requires every action be user-mappable, not that every action ship
// with a default combo.
registerAction({
	id: "app.openSettings",
	defaultCombo: "",
	scope: "global",
	descriptionKey: "settings"
})

// Mirrors app.openSettings directly above — same unassigned-by-default route-nav shape, wired the
// same way in IconRail below.
registerAction({
	id: "app.openTransfers",
	defaultCombo: "",
	scope: "global",
	descriptionKey: "moduleTransfers"
})

// Rail section slot: the active section rides a white chip (soft shadow); inactive glyphs are plain
// muted marks on the canvas that tint on hover. No borders — the chip and hover fills carry the
// state entirely. Reused by every real section entry (Drive, Contacts, Transfers) so they stay
// visually identical.
function railItemClass(active: boolean): string {
	return cn(
		// app-region-no-drag: every rail item is a real click target inside the rail's own drag region
		// (see IconRail's <nav> below).
		"flex size-9 items-center justify-center rounded-lg transition-colors outline-none app-region-no-drag focus-visible:ring-3 focus-visible:ring-ring/40 [&_svg]:size-[22px] [&_svg]:shrink-0",
		active ? "bg-rail-chip text-rail-chip-foreground shadow-sm" : "text-muted-foreground hover:bg-rail-hover hover:text-foreground"
	)
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
	const { setTheme } = useTheme()
	const accountQuery = useAccountQuery()
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [pending, setPending] = useState(false)

	async function handleSignOut(): Promise<void> {
		setPending(true)
		try {
			await performLogout()
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
								setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark")
							}}
						>
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
				body={t("auth:logoutConfirmBody")}
				confirmLabel={t("signOut")}
				cancelLabel={t("cancel")}
				destructive
				onOpenChange={setConfirmOpen}
				onConfirm={() => {
					void handleSignOut()
				}}
			/>
		</>
	)
}

// P3 — this used to be a Popover trigger showing a quick-glance panel, with a "See all" footer link
// to the real screen; Jan disliked the extra click/indirection, so it is now a plain nav Link like
// every other rail entry above, straight to /transfers. M1 — also renders the aggregate {percent,
// speed} computeTransfersAggregate already computes (previously only activeCount was read anywhere):
// a slim progress sliver along the icon's own bottom edge for `percent`, and the live rolling-window
// `speed` folded into the tooltip text — mirrors mobile's floating pill's own speed+progress readout,
// condensed to fit this narrow rail slot instead of a separate persistent surface.
function TransfersEntry({ active }: { active: boolean }) {
	const { t } = useTranslation(["common", "transfers"])
	const { activeCount, percent, speed } = useTransfersAggregate()
	const showAggregate = shouldShowTransfersAggregate(activeCount)

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Link
						to="/transfers"
						aria-current={active ? "page" : undefined}
						aria-label={
							activeCount > 0 ? t("transfers:transfersActiveBadge", { count: activeCount }) : t("common:moduleTransfers")
						}
						className={cn(railItemClass(active), "relative")}
					>
						<ArrowDownUpIcon />
						{activeCount > 0 ? (
							// aria-hidden: the count is already folded into the Link's own aria-label above — a
							// labelled element ignores descendant content for its accessible name, so a label
							// here would be dead weight, not a second announcement.
							<Badge
								aria-hidden="true"
								className="absolute -top-1 -right-1 h-4 min-w-4 justify-center rounded-full px-1 text-[10px] tabular-nums"
							>
								{activeCount}
							</Badge>
						) : null}
						{showAggregate ? (
							<span
								aria-hidden="true"
								className="absolute inset-x-1.5 bottom-1 h-0.5 overflow-hidden rounded-full bg-foreground/15"
							>
								<span
									className="block h-full rounded-full bg-primary transition-[width]"
									style={{ width: `${String(percent)}%` }}
								/>
							</span>
						) : null}
					</Link>
				}
			/>
			<TooltipContent side="right">
				{t("common:moduleTransfers")}
				{showAggregate ? (
					<span className="text-background/60"> · {t("transfers:transfersAggregateSpeed", { speed: formatBytes(speed) })}</span>
				) : null}
			</TooltipContent>
		</Tooltip>
	)
}

export function IconRail() {
	const { t } = useTranslation()
	const navigate = useNavigate()
	// Same read as __root.tsx's BootGate (the app's other consumer of the current path). Drive's own
	// route is a "/drive/$" splat, so its match also covers every nested directory, not just the bare
	// "/drive" root — Contacts has no nested path, so an exact match is enough for it.
	const pathname = useRouterState({ select: state => state.location.pathname })
	const driveActive = pathname === "/drive" || pathname.startsWith("/drive/")
	const contactsActive = pathname === "/contacts"
	// Notes is a two-route module (/notes selection index + /notes/$uuid) — like Drive's splat, its
	// active state must cover the nested selection path too, not just the bare root.
	const notesActive = pathname === "/notes" || pathname.startsWith("/notes/")
	// Chats mirrors Notes: a two-route module (/chats index + /chats/$uuid selection), so its active state
	// covers the nested thread path too.
	const chatsActive = pathname === "/chats" || pathname.startsWith("/chats/")
	// Transfers is a flat page, no splat — an exact match is enough (mirrors contactsActive).
	const transfersActive = pathname === "/transfers"
	// In-app unread signal: a numeric rail badge driven by the CLIENT-DERIVED global unread count (summed
	// per-message across every chat, not a server scalar). Always mounted with the authed shell, so this
	// hook is also the mount-once trigger for the bulk chat+messages refetch that makes the count possible
	// (useChatsUnreadCount) — the badge reflects unread regardless of which module is open.
	const currentUserId = useAccountQuery().data?.id
	const unreadChatsCount = useChatsUnreadCount(currentUserId)
	// Incoming contact-request count for the Contacts nav badge — mounting the already-batched requests
	// query here (rather than only on /contacts) keeps it warm at launch and surfaces the count app-wide,
	// mirroring how the transfers/unread badges are always-present.
	const contactRequestsQuery = useContactRequestsQuery()
	const incomingRequestCount = contactRequestsQuery.status === "success" ? contactRequestsQuery.data.incoming.length : 0

	// Registered above at module scope (default unassigned) — this only wires the LIVE combo, which
	// starts as "" (react-hotkeys-hook's parser treats it as "never matches") and works the instant a
	// user rebinds it via a future shortcuts UI, with no further code change. Guarded on
	// isAnyDialogOpen() (dialogGuard.ts, the same shared Base UI signal themeProvider.tsx uses — this
	// rail is mounted outside the drive feature's own isDialogOpen chain too) so a rebound combo can't
	// navigate away out from under an open dialog/preview.
	useAction(
		"app.openSettings",
		() => {
			if (isAnyDialogOpen()) {
				return
			}

			void navigate({ to: "/settings/account" })
		},
		undefined,
		[navigate]
	)

	// Mirrors the app.openSettings wiring directly above.
	useAction(
		"app.openTransfers",
		() => {
			if (isAnyDialogOpen()) {
				return
			}

			void navigate({ to: "/transfers" })
		},
		undefined,
		[navigate]
	)

	return (
		<nav
			aria-label={t("appName")}
			// Drag region (Electron plumbing): a plain browser ignores -webkit-app-region entirely, so
			// this is inert weight everywhere else. Every interactive descendant below opts back out
			// with app-region-no-drag so it stays clickable.
			className="flex w-12 shrink-0 flex-col items-center gap-1.5 py-1.5 app-region-drag"
		>
			<Link
				to="/drive/$"
				params={{ _splat: "" }}
				aria-label={t("moduleDrive")}
				className="mb-1.5 flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none app-region-no-drag focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-rail-chip dark:text-rail-chip-foreground"
			>
				<Logo className="size-5" />
			</Link>

			<Tooltip>
				<TooltipTrigger
					render={
						<Link
							to="/drive/$"
							params={{ _splat: "" }}
							aria-current={driveActive ? "page" : undefined}
							aria-label={t("moduleDrive")}
							className={railItemClass(driveActive)}
						>
							<FolderClosedIcon />
						</Link>
					}
				/>
				<TooltipContent side="right">{t("moduleDrive")}</TooltipContent>
			</Tooltip>

			<Tooltip>
				<TooltipTrigger
					render={
						<Link
							to="/contacts"
							search={{ section: DEFAULT_CONTACTS_SECTION_FILTER }}
							aria-current={contactsActive ? "page" : undefined}
							aria-label={
								incomingRequestCount > 0 ? t("contactRequestsBadge", { count: incomingRequestCount }) : t("moduleContacts")
							}
							className={cn(railItemClass(contactsActive), "relative")}
						>
							<UsersIcon />
							{incomingRequestCount > 0 ? (
								// aria-hidden: the count is folded into the Link's own aria-label above (a labelled
								// element ignores descendant content for its accessible name), so this badge is a
								// visual cue only — mirrors TransfersEntry's badge.
								<Badge
									aria-hidden="true"
									className="absolute -top-1 -right-1 h-4 min-w-4 justify-center rounded-full px-1 text-[10px] tabular-nums"
								>
									{incomingRequestCount}
								</Badge>
							) : null}
						</Link>
					}
				/>
				<TooltipContent side="right">{t("moduleContacts")}</TooltipContent>
			</Tooltip>

			<Tooltip>
				<TooltipTrigger
					render={
						<Link
							to="/notes"
							aria-current={notesActive ? "page" : undefined}
							aria-label={t("moduleNotes")}
							className={railItemClass(notesActive)}
						>
							<NotebookPenIcon />
						</Link>
					}
				/>
				<TooltipContent side="right">{t("moduleNotes")}</TooltipContent>
			</Tooltip>

			<TransfersEntry active={transfersActive} />

			<Tooltip>
				<TooltipTrigger
					render={
						<Link
							to="/chats"
							aria-current={chatsActive ? "page" : undefined}
							aria-label={unreadChatsCount > 0 ? t("chatsUnreadBadge", { count: unreadChatsCount }) : t("moduleChats")}
							className={cn(railItemClass(chatsActive), "relative")}
						>
							<MessagesSquareIcon />
							{unreadChatsCount > 0 ? (
								// aria-hidden: the count is folded into the Link's own aria-label below; the badge is a
								// visual cue only (mirrors TransfersEntry's badge).
								<Badge
									aria-hidden="true"
									className="absolute -top-1 -right-1 h-4 min-w-4 justify-center rounded-full px-1 text-[10px] tabular-nums"
								>
									{unreadChatsCount}
								</Badge>
							) : null}
						</Link>
					}
				/>
				<TooltipContent side="right">{t("moduleChats")}</TooltipContent>
			</Tooltip>

			{/* Pinned footer — the rail's extensible utility slot list; future entries stack above the
			    account menu. */}
			<div className="mt-auto flex w-full flex-col items-center gap-1.5">
				<HelpEntry />
				<AccountMenu />
			</div>
		</nav>
	)
}
