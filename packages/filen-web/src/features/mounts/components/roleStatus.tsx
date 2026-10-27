import type { DesktopMountsRoleState } from "@filen/shared/desktop"
import { cn } from "@filen/shared"
import { ROLE_STATE_TONE, type RoleTone } from "@/features/mounts/lib/mountsStatus.logic"

const TONE_DOT_CLASS: Record<RoleTone, string> = {
	off: "bg-muted-foreground/35",
	busy: "animate-pulse bg-primary motion-reduce:animate-none",
	on: "bg-emerald-500",
	error: "bg-destructive"
}

// A role's state as a dot. Decorative: its state label sits beside it, or is folded into the row's name.
export function RoleStatusDot({ state, className }: { state: DesktopMountsRoleState; className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn("size-2 shrink-0 rounded-full", TONE_DOT_CLASS[ROLE_STATE_TONE[state]], className)}
		/>
	)
}
