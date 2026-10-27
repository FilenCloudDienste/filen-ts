import type { ReactNode } from "react"
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "@filen/shared"

export type DesktopCalloutTone = "info" | "warning" | "error"

const TONE_CLASS: Record<DesktopCalloutTone, string> = {
	info: "bg-muted/70 text-foreground ring-border/60",
	warning: "bg-warning/12 text-warning-foreground ring-warning/25",
	error: "bg-destructive/8 text-destructive ring-destructive/20"
}

const TONE_ICON: Record<DesktopCalloutTone, { icon: typeof InfoIcon; className: string }> = {
	info: { icon: InfoIcon, className: "text-muted-foreground" },
	warning: { icon: TriangleAlertIcon, className: "" },
	error: { icon: CircleAlertIcon, className: "" }
}

// A tinted message inside the desktop app's sections (host state, notices, warnings, refusals): an optional bold
// `title` over the text, and `action` beside it where the callout is wide enough (a content page), else under it (a
// sidebar). Only warnings and errors announce.
export function DesktopCallout({
	tone,
	title,
	children,
	action,
	className
}: {
	tone: DesktopCalloutTone
	title?: string
	children?: ReactNode
	action?: ReactNode
	className?: string
}) {
	const { icon: Icon, className: iconClass } = TONE_ICON[tone]

	return (
		<div
			role={tone === "info" ? undefined : "alert"}
			className={cn("@container rounded-2xl px-3.5 py-3 text-sm ring-1", TONE_CLASS[tone], className)}
		>
			<div className="flex flex-col gap-2.5 @md:flex-row @md:items-center @md:gap-4">
				<div className="flex min-w-0 flex-1 items-start gap-2.5">
					<Icon
						aria-hidden="true"
						className={cn("mt-0.5 size-4 shrink-0", iconClass)}
					/>
					<div className="flex min-w-0 flex-1 flex-col gap-0.5 break-words">
						{title === undefined ? null : <p className="font-medium">{title}</p>}
						{children === undefined ? null : <div className={cn(title !== undefined && "opacity-85")}>{children}</div>}
					</div>
				</div>
				{action === undefined || action === null ? null : (
					<div className="flex shrink-0 flex-wrap items-center gap-2 pl-6.5 @md:pl-0">{action}</div>
				)}
			</div>
		</div>
	)
}
