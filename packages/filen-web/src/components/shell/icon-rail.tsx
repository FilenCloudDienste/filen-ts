import { useEffect, useState, type ComponentType } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
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
	TriangleAlertIcon,
	UserIcon
} from "lucide-react"
import type { CommonKey } from "@/lib/i18n"
import { runLogout } from "@/lib/auth/logout"
import { sdkApi } from "@/lib/sdk/client"
import { clearSession, broadcastAuth, getSessionEmail } from "@/lib/sdk/session"
import { kvClear } from "@/lib/storage/adapter"
import { queryClient } from "@/queries/client"
import { Logo } from "@/components/shell/logo"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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
import { ConfirmDialog } from "@/components/dialogs/confirm-dialog"
import { Kbd } from "@/lib/keymap/Kbd"
import { useBootStore } from "@/stores/boot"

type IconType = ComponentType<{ className?: string }>

// The module surfaces beyond Drive land later — rendered as inert, muted rail entries so
// the information architecture reads intact without pretending the destinations exist yet. Native
// `disabled` is deliberately avoided (it suppresses pointer events, which would kill the tooltip);
// `aria-disabled` + muted styling conveys the same state while keeping hover/focus explainers.
const MODULES: { key: CommonKey; icon: IconType }[] = [
	{ key: "moduleTransfers", icon: ArrowDownUpIcon },
	{ key: "moduleNotes", icon: NotebookPenIcon },
	{ key: "moduleChats", icon: MessagesSquareIcon },
	{ key: "moduleContacts", icon: UsersIcon }
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
	// Stopgap until the account query (getUserInfo) lands: a cheap local kv read, no network — falls
	// back to the static "Account" label below on a missing/unreadable session.
	const [email, setEmail] = useState<string | null>(null)
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [pending, setPending] = useState(false)

	useEffect(() => {
		let cancelled = false
		void getSessionEmail()
			.then(value => {
				if (!cancelled) {
					setEmail(value)
				}
			})
			.catch(() => undefined) // best-effort — the static label stands in on any read failure
		return () => {
			cancelled = true
		}
	}, [])

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
						<DropdownMenuLabel className="truncate">{email ?? t("account")}</DropdownMenuLabel>
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

export function IconRail() {
	const { t } = useTranslation()
	const ephemeral = useBootStore(s => s.ephemeral)

	return (
		<nav
			aria-label={t("appName")}
			className="flex h-svh w-16 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-3"
		>
			<Link
				to="/drive"
				aria-label={t("moduleDrive")}
				className="mb-1 flex size-9 items-center justify-center rounded-2xl text-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
			>
				<Logo className="size-7" />
			</Link>

			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant="secondary"
							size="icon-lg"
							aria-current="page"
							aria-label={t("moduleDrive")}
						>
							<FolderClosedIcon />
						</Button>
					}
				/>
				<TooltipContent side="right">{t("moduleDrive")}</TooltipContent>
			</Tooltip>

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
				{ephemeral ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<Badge
									variant="secondary"
									className="size-7 rounded-full p-0"
									aria-label={t("ephemeralSession")}
								>
									<TriangleAlertIcon />
								</Badge>
							}
						/>
						<TooltipContent side="right">{t("ephemeralSession")}</TooltipContent>
					</Tooltip>
				) : null}

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
							<Button
								variant="ghost"
								size="icon-lg"
								aria-disabled="true"
								aria-label={t("settings")}
								className="text-muted-foreground/60 hover:bg-transparent hover:text-muted-foreground/60"
							>
								<SettingsIcon />
							</Button>
						}
					/>
					<TooltipContent side="right">
						{t("settings")}
						<span className="text-background/60">· {t("comingSoon")}</span>
					</TooltipContent>
				</Tooltip>
			</div>
		</nav>
	)
}
