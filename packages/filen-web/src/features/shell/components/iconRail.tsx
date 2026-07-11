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
import { cn } from "@/lib/utils"
import { runLogout } from "@/lib/logout"
import { sync as notesSync } from "@/features/notes/lib/sync"
import { sync as chatsSync } from "@/features/chats/lib/sync"
import { clearAllTyping } from "@/features/chats/lib/typing"
import { useChatsUnread } from "@/features/chats/queries/chatsUnread"
import { socketBridge } from "@/lib/sdk/socket"
import { sdkApi } from "@/lib/sdk/client"
import { clearSession, broadcastAuth } from "@/lib/sdk/session"
import { kvClear } from "@/lib/storage/adapter"
import { queryClient } from "@/queries/client"
import { useAccountQuery } from "@/queries/account"
import { useTransfersAggregate } from "@/features/transfers/store/useTransfersStore"
import { TransfersPanel } from "@/features/transfers/components/transfersPanel"
import { Logo } from "@/features/shell/components/logo"
import { useTheme } from "@/providers/themeProvider"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
		// Notes + chats sync cancel BEFORE the wipe: abort each outbox loop and suppress any further disk
		// write so a late flush can never resurrect this account's plaintext queue after kv-clear lands.
		notesSync.cancel()
		chatsSync.cancel()
		// Stop every typing watchdog + wipe the typing store so no timer fires into the cleared session.
		clearAllTyping()
		// Tear the realtime socket down before the client is released — unsubscribeFromSocket needs the
		// live client. Fire-and-forget: the worker also frees the listener in releaseClient as a backstop.
		void socketBridge.stop()
		try {
			await runLogout({
				cancelQueries: () => queryClient.cancelQueries(),
				clearQueryCache: () => {
					queryClient.clear()
				},
				sdkLogout: () => sdkApi.logout(),
				clearSession,
				kvClear,
				broadcast: () => {
					broadcastAuth("logout")
				},
				reload: () => {
					location.reload()
				}
			})
		} finally {
			// runLogout isolates every phase internally (log-and-continue) and never rejects; this
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

// The one MODULES entry promoted out of the inert loop above: a real Popover trigger (still a
// Popover, not a Link — it stays the quick glance; the panel's own "See all" footer is the Link to
// the full /transfers screen) showing the rail's live active-upload count. No Tooltip wrapper, unlike
// every Link-driven entry above — mirrors AccountMenu just above (the rail's other overlay-opening
// trigger), which also skips one; nesting a hover Tooltip and a click Popover on the same trigger is
// an untested composition in this codebase, not worth risking here. Open state is lifted and
// controlled (rather than the uncontrolled default every other Popover.Root usage would default to)
// solely so the panel's "See all" link can close it on navigate — see TransfersPanelProps.onClose.
function TransfersEntry() {
	const { t } = useTranslation(["common", "transfers"])
	const { activeCount } = useTransfersAggregate()
	const [open, setOpen] = useState(false)

	return (
		<Popover
			open={open}
			onOpenChange={setOpen}
		>
			<PopoverTrigger
				render={
					<button
						type="button"
						aria-label={
							activeCount > 0 ? t("transfers:transfersActiveBadge", { count: activeCount }) : t("common:moduleTransfers")
						}
						className={cn(railItemClass(open), "relative")}
					>
						<ArrowDownUpIcon />
						{activeCount > 0 ? (
							// aria-hidden: the count is already folded into the button's own aria-label above —
							// a button with an explicit aria-label ignores descendant content (including any
							// aria-label on this badge) when computing its accessible name, so a label here would
							// be dead weight, not a second announcement.
							<Badge
								aria-hidden="true"
								className="absolute -top-1 -right-1 h-4 min-w-4 justify-center rounded-full px-1 text-[10px] tabular-nums"
							>
								{activeCount}
							</Badge>
						) : null}
					</button>
				}
			/>
			<PopoverContent
				side="right"
				align="end"
				className="w-80"
			>
				<TransfersPanel
					onClose={() => {
						setOpen(false)
					}}
				/>
			</PopoverContent>
		</Popover>
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
	// In-app unread signal: a subtle rail dot driven by the global unread count. Always mounted with
	// the authed shell, so the badge reflects unread regardless of which module is open. A background
	// pending state simply shows no dot.
	const chatsUnreadQuery = useChatsUnread()
	const hasUnreadChats = (chatsUnreadQuery.data ?? 0n) > 0n

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
							aria-current={contactsActive ? "page" : undefined}
							aria-label={t("moduleContacts")}
							className={railItemClass(contactsActive)}
						>
							<UsersIcon />
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

			<TransfersEntry />

			<Tooltip>
				<TooltipTrigger
					render={
						<Link
							to="/chats"
							aria-current={chatsActive ? "page" : undefined}
							aria-label={t("moduleChats")}
							className={cn(railItemClass(chatsActive), "relative")}
						>
							<MessagesSquareIcon />
							{hasUnreadChats ? (
								// aria-hidden: the rail entry's own aria-label already names the module; the dot is a
								// decorative unread cue, not a second announcement (mirrors TransfersEntry's badge).
								<span
									aria-hidden="true"
									className="absolute top-1 right-1 size-2 rounded-full bg-primary ring-2 ring-canvas"
								/>
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
