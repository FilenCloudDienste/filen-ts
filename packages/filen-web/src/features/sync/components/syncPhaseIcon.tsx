import {
	BanIcon,
	CircleAlertIcon,
	CircleCheckIcon,
	CirclePauseIcon,
	CloudOffIcon,
	CloudDownloadIcon,
	FolderSearchIcon,
	FolderXIcon,
	HourglassIcon,
	ListChecksIcon,
	RefreshCwIcon,
	TriangleAlertIcon
} from "lucide-react"
import type { DesktopSyncPhase } from "@filen/shared/desktop"
import { cn } from "@filen/shared"

const PHASE_ICON: Record<DesktopSyncPhase, { icon: typeof BanIcon; className: string }> = {
	idle: { icon: CircleCheckIcon, className: "text-emerald-600 dark:text-emerald-500" },
	syncing: { icon: RefreshCwIcon, className: "animate-spin text-primary motion-reduce:animate-none" },
	paused: { icon: CirclePauseIcon, className: "text-muted-foreground" },
	preparing: { icon: HourglassIcon, className: "text-muted-foreground" },
	review: { icon: ListChecksIcon, className: "text-warning-foreground" },
	waitingForRoot: { icon: FolderXIcon, className: "text-warning-foreground" },
	unsupported: { icon: BanIcon, className: "text-muted-foreground" },
	error: { icon: CircleAlertIcon, className: "text-destructive" },
	waitingForCloud: { icon: CloudDownloadIcon, className: "text-muted-foreground" },
	indexing: { icon: FolderSearchIcon, className: "text-primary" },
	offline: { icon: CloudOffIcon, className: "text-muted-foreground" }
}

// A pair's phase at a glance. An idle pair with open issues shows the warning instead of the check: it is up to
// date only for what it could sync. Decorative: the phase label sits beside it wherever it is read.
export function SyncPhaseIcon({ phase, hasIssues, className }: { phase: DesktopSyncPhase; hasIssues: boolean; className?: string }) {
	const { icon: Icon, className: toneClass } =
		hasIssues && phase === "idle" ? { icon: TriangleAlertIcon, className: "text-warning-foreground" } : PHASE_ICON[phase]

	return (
		<Icon
			aria-hidden="true"
			className={cn("size-4 shrink-0", toneClass, className)}
		/>
	)
}
