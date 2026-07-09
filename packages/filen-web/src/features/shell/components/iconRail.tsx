import { useState, type ComponentType } from "react"
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
	UserIcon
} from "lucide-react"
import type { CommonKey } from "@/lib/i18n"
import { runLogout } from "@/lib/logout"
import { sdkApi } from "@/lib/sdk/client"
import { clearSession, broadcastAuth } from "@/lib/sdk/session"
import { kvClear } from "@/lib/storage/adapter"
import { queryClient } from "@/queries/client"
import { useAccountQuery } from "@/queries/account"
import { useTransfersAggregate } from "@/features/transfers/store/useTransfersStore"
import { useExportKeysReminder } from "@/features/settings/components/security/exportMasterKeys"
import { TransfersPanel } from "@/features/transfers/components/transfersPanel"
import { Logo } from "@/features/shell/components/logo"
import { useTheme } from "@/providers/themeProvider"
import { Button, buttonVariants } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { registerAction } from "@/lib/keymap/registry"
import { useAction } from "@/lib/keymap/useAction"
import { Kbd } from "@/lib/keymap/kbd"

// Registered at module scope (runs once per module evaluation — mirrors theme-provider.tsx's own
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

type IconType = ComponentType<{ className?: string }>

// The remaining module surfaces land later — rendered as inert, muted rail entries so the
// information architecture reads intact without pretending the destinations exist yet (Contacts and
// Transfers have since landed as real entries: Contacts a Link mirroring Drive above, Transfers the
// TransfersEntry popover below). Native `disabled` is deliberately avoided (it suppresses pointer
// events, which would kill the tooltip); `aria-disabled` + muted styling conveys the same state while
// keeping hover/focus explainers.
const MODULES: { key: CommonKey; icon: IconType }[] = [
	{ key: "moduleNotes", icon: NotebookPenIcon },
	{ key: "moduleChats", icon: MessagesSquareIcon }
]

function ThemeToggle() {
	const { t } = useTranslation()
	const { setTheme } = useTheme()

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-lg"
						aria-label={t("toggleTheme")}
						onClick={() => {
							setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark")
						}}
					>
						<SunIcon className="dark:hidden" />
						<MoonIcon className="hidden dark:block" />
					</Button>
				}
			/>
			<TooltipContent side="right">
				{t("toggleTheme")}
				<Kbd action="app.toggleTheme" />
			</TooltipContent>
		</Tooltip>
	)
}

function AccountMenu() {
	const { t } = useTranslation(["common", "auth"])
	const accountQuery = useAccountQuery()
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [pending, setPending] = useState(false)

	async function handleSignOut(): Promise<void> {
		setPending(true)
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
							className="rounded-full"
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
					className="min-w-44"
				>
					<DropdownMenuGroup>
						<DropdownMenuLabel className="truncate">{accountQuery.data?.email ?? t("account")}</DropdownMenuLabel>
						<DropdownMenuItem
							onClick={() => {
								setConfirmOpen(true)
							}}
						>
							<LogOutIcon />
							{t("signOut")}
						</DropdownMenuItem>
					</DropdownMenuGroup>
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
					<Button
						variant="ghost"
						size="icon-lg"
						aria-label={
							activeCount > 0 ? t("transfers:transfersActiveBadge", { count: activeCount }) : t("common:moduleTransfers")
						}
						className="relative"
					>
						<ArrowDownUpIcon />
						{activeCount > 0 ? (
							// aria-hidden: the count is already folded into the Button's own aria-label above —
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
					</Button>
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

	// Mounted once here (the icon rail exists for the app's whole authed lifetime, independent of
	// which route is active) rather than on the security route itself, so the nag can fire and route
	// TO that page even when the user never opens it unprompted.
	useExportKeysReminder()

	// Registered above at module scope (default unassigned) — this only wires the LIVE combo, which
	// starts as "" (react-hotkeys-hook's parser treats it as "never matches") and works the instant a
	// user rebinds it via a future shortcuts UI, with no further code change.
	useAction(
		"app.openSettings",
		() => {
			void navigate({ to: "/settings/security" })
		},
		undefined,
		[navigate]
	)

	// Mirrors the app.openSettings wiring directly above.
	useAction(
		"app.openTransfers",
		() => {
			void navigate({ to: "/transfers" })
		},
		undefined,
		[navigate]
	)

	return (
		<nav
			aria-label={t("appName")}
			className="flex h-svh w-16 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-3"
		>
			<Link
				to="/drive/$"
				params={{ _splat: "" }}
				aria-label={t("moduleDrive")}
				className="mb-1 flex size-9 items-center justify-center rounded-2xl text-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
			>
				<Logo className="size-7" />
			</Link>

			<Tooltip>
				<TooltipTrigger
					render={
						<Link
							to="/drive/$"
							params={{ _splat: "" }}
							aria-current={driveActive ? "page" : undefined}
							aria-label={t("moduleDrive")}
							className={buttonVariants({ variant: driveActive ? "secondary" : "ghost", size: "icon-lg" })}
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
							className={buttonVariants({ variant: contactsActive ? "secondary" : "ghost", size: "icon-lg" })}
						>
							<UsersIcon />
						</Link>
					}
				/>
				<TooltipContent side="right">{t("moduleContacts")}</TooltipContent>
			</Tooltip>

			<TransfersEntry />

			{MODULES.map(({ key, icon: Icon }) => (
				<Tooltip key={key}>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-lg"
								aria-disabled="true"
								aria-label={t(key)}
								className="text-muted-foreground/60 hover:bg-transparent hover:text-muted-foreground/60"
							>
								<Icon />
							</Button>
						}
					/>
					<TooltipContent side="right">
						{t(key)}
						<span className="text-background/60">· {t("comingSoon")}</span>
					</TooltipContent>
				</Tooltip>
			))}

			<div className="mt-auto flex w-full flex-col items-center gap-2">
				<AccountMenu />

				<Tooltip>
					<TooltipTrigger
						render={
							<div
								className="flex w-full flex-col items-center gap-1.5 px-3 py-1"
								aria-label={t("storage")}
							>
								<Skeleton className="h-1.5 w-full rounded-full" />
								<Skeleton className="h-1.5 w-6 rounded-full" />
							</div>
						}
					/>
					<TooltipContent side="right">{t("storage")}</TooltipContent>
				</Tooltip>

				<Separator className="w-8" />
				<ThemeToggle />

				<Tooltip>
					<TooltipTrigger
						render={
							<Link
								to="/settings/security"
								aria-label={t("settings")}
								className={buttonVariants({ variant: "ghost", size: "icon-lg" })}
							>
								<SettingsIcon />
							</Link>
						}
					/>
					<TooltipContent side="right">
						{t("settings")}
						<Kbd action="app.openSettings" />
					</TooltipContent>
				</Tooltip>
			</div>
		</nav>
	)
}
