import { cn } from "@filen/shared"
import type { RoleTone } from "@/features/mounts/lib/mountsStatus.logic"

const TONE_DOT_CLASS: Record<RoleTone, string> = {
	off: "bg-muted-foreground/35",
	busy: "animate-pulse bg-primary motion-reduce:animate-none",
	on: "bg-emerald-500",
	warning: "bg-warning",
	error: "bg-destructive"
}

// A role's state as a dot, by its tone. Decorative: its state label sits beside it, or is folded into the row's name.
export function RoleStatusDot({ tone, className }: { tone: RoleTone; className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn("size-2 shrink-0 rounded-full", TONE_DOT_CLASS[tone], className)}
		/>
	)
}
