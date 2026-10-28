import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import type { DesktopMountsError } from "@filen/shared/desktop"
import { Button } from "@/components/ui/button"
import { log } from "@/lib/log"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"
import { mountsApi, useMountsStore } from "@/features/mounts/lib/mountsStore"
import { NOTICE_KEY, NOTICE_SCOPE } from "@/features/mounts/lib/mountsStatus.logic"
import { ROLE_ICON } from "@/features/mounts/lib/mountsIcons"
import { mountsErrorLabel } from "@/features/mounts/lib/mountsActions"
import type { MountsRole } from "@/features/mounts/lib/mountsRoles"

// One Mounts page: a title bar like Drive's over the one scroll container, in the Settings column.
export function MountsPage({ role, title, children }: { role: MountsRole; title: string; children: ReactNode }) {
	const Icon = ROLE_ICON[role]

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/50 px-4 app-region-chrome">
				<Icon
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<h1 className="truncate font-heading text-base font-medium tracking-tight">{title}</h1>
			</header>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-6 pb-12 sm:px-6">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-8">{children}</div>
			</div>
		</>
	)
}

// A page's hero with the callouts docked under it, closer together than the sections below.
export function HeroSection({ children }: { children: ReactNode }) {
	return <div className="flex flex-col gap-3">{children}</div>
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
