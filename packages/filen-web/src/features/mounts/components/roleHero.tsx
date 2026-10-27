import type { ReactNode } from "react"
import type { DesktopMountsRoleState } from "@filen/shared/desktop"
import { cn } from "@filen/shared"
import { SettingsPanel } from "@/features/settings/components/settingsLayout"
import { ROLE_ICON } from "@/features/mounts/lib/mountsIcons"
import { ROLE_STATE_TONE, type RoleTone } from "@/features/mounts/lib/mountsStatus.logic"
import type { MountsRole } from "@/features/mounts/lib/mountsRoles"

const TONE_CHIP_CLASS: Record<RoleTone, string> = {
	off: "bg-muted text-muted-foreground",
	busy: "bg-primary/10 text-primary",
	on: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
	error: "bg-destructive/10 text-destructive"
}

// The top card of a Mounts page and the drive's card in the overview, in the Settings account card's shape: the
// role's icon tinted by its state, a title over a status line, its switch, then its most used rows.
export function RoleHero({
	role,
	state,
	title,
	status,
	control,
	children
}: {
	role: MountsRole
	state: DesktopMountsRoleState
	title: ReactNode
	status: ReactNode
	control: ReactNode
	children?: ReactNode
}) {
	const Icon = ROLE_ICON[role]

	return (
		<SettingsPanel className="divide-y divide-border/60">
			<div
				data-slot="settings-row"
				className="flex items-center gap-4 p-5"
			>
				<span
					className={cn(
						"flex size-12 shrink-0 items-center justify-center rounded-2xl transition-colors",
						TONE_CHIP_CLASS[ROLE_STATE_TONE[state]]
					)}
				>
					<Icon
						aria-hidden="true"
						className="size-6"
					/>
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="truncate font-heading text-lg font-medium tracking-tight">{title}</div>
					<div className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">{status}</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">{control}</div>
			</div>
			{children}
		</SettingsPanel>
	)
}
