import type { ReactNode } from "react"
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "@filen/shared"

export type SyncCalloutTone = "info" | "warning" | "error"

const TONE_CLASS: Record<SyncCalloutTone, string> = {
	info: "bg-muted text-foreground",
	warning: "bg-warning/15 text-warning-foreground",
	error: "bg-destructive/10 text-destructive"
}

const TONE_ICON: Record<SyncCalloutTone, typeof InfoIcon> = {
	info: InfoIcon,
	warning: TriangleAlertIcon,
	error: CircleAlertIcon
}

// A tinted one-paragraph message inside the Sync section (host state, notices, root warnings, refusals), the
// same shape as the Videos chooser's warning. `action` sits under the text; only warnings and errors announce.
export function SyncCallout({
	tone,
	children,
	action,
	className
}: {
	tone: SyncCalloutTone
	children: ReactNode
	action?: ReactNode
	className?: string
}) {
	const Icon = TONE_ICON[tone]

	return (
		<div
			role={tone === "info" ? undefined : "alert"}
			className={cn("flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-sm", TONE_CLASS[tone], className)}
		>
			<Icon
				aria-hidden="true"
				className="mt-0.5 size-4 shrink-0"
			/>
			<div className="flex min-w-0 flex-1 flex-col items-start gap-2">
				<div className="min-w-0 break-words">{children}</div>
				{action}
			</div>
		</div>
	)
}
