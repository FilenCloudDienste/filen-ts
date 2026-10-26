import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { CircleAlertIcon, CircleCheckIcon, CircleIcon, LoaderCircleIcon } from "lucide-react"
import type { DesktopMountsError, DesktopMountsRoleState } from "@filen/shared/desktop"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { log } from "@/lib/log"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"
import { mountsApi, useMountsStore } from "@/features/mounts/lib/mountsStore"
import { NOTICE_KEY, NOTICE_SCOPE, roleStateKey } from "@/features/mounts/lib/mountsStatus.logic"
import { mountsErrorLabel } from "@/features/mounts/lib/mountsActions"
import type { MountsRole } from "@/features/mounts/lib/mountsRoles"

const STATE_ICON: Record<DesktopMountsRoleState, { icon: typeof CircleIcon; className: string }> = {
	off: { icon: CircleIcon, className: "text-muted-foreground" },
	starting: { icon: LoaderCircleIcon, className: "animate-spin text-primary motion-reduce:animate-none" },
	running: { icon: CircleCheckIcon, className: "text-emerald-600 dark:text-emerald-500" },
	stopping: { icon: LoaderCircleIcon, className: "animate-spin text-muted-foreground motion-reduce:animate-none" },
	error: { icon: CircleAlertIcon, className: "text-destructive" }
}

// One Mounts page: its title and state over the one scroll container, laid out like a sync pair's page.
export function MountsPage({
	role,
	title,
	state,
	children
}: {
	role: MountsRole
	title: string
	state: DesktopMountsRoleState
	children: ReactNode
}) {
	const { t } = useTranslation("mounts")
	const { icon: Icon, className } = STATE_ICON[state]

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-3 px-4">
				<Icon
					aria-hidden="true"
					className={cn("size-4 shrink-0", className)}
				/>
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<h1 className="truncate font-heading text-base font-medium tracking-tight">{title}</h1>
					<p className="shrink-0 text-xs text-muted-foreground">{t(roleStateKey(role, state))}</p>
				</div>
			</header>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-2 pb-12 sm:px-6">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-8">{children}</div>
			</div>
		</>
	)
}

// Why a role is down, as the shell reported it.
export function RoleErrorCallout({ error }: { error: DesktopMountsError | null }) {
	if (error === null) {
		return null
	}

	return <DesktopCallout tone="error">{mountsErrorLabel(error)}</DesktopCallout>
}

// What the shell tells once until dismissed, on the page it is about. Dismissing drops it from the next overview.
export function MountsNoticeBanner({ scope }: { scope: "drive" | "serve" }) {
	const { t } = useTranslation("mounts")
	const notices = useMountsStore(useShallow(state => state.overview?.notices.filter(notice => NOTICE_SCOPE[notice] === scope) ?? []))

	if (notices.length === 0) {
		return null
	}

	return (
		<div className="flex flex-col gap-2">
			{notices.map(notice => (
				<DesktopCallout
					key={notice}
					tone="info"
					action={
						<Button
							variant="outline"
							size="xs"
							onClick={() => {
								mountsApi()
									.dismissNotice(notice)
									.catch((error: unknown) => {
										log.warn("mounts", "notice could not be dismissed", error)
									})
							}}
						>
							{t("noticeDismiss")}
						</Button>
					}
				>
					{t(NOTICE_KEY[notice])}
				</DesktopCallout>
			))}
		</div>
	)
}
