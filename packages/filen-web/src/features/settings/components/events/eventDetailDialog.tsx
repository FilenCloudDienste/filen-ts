import { useTranslation } from "react-i18next"
import type { UserEvent } from "@filen/sdk-rs"
import { eventKindMeta } from "@/features/settings/lib/eventKind"
import { buildEventDetailRows } from "@/features/settings/lib/eventDetail"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { MiddleEllipsis } from "@/components/middleEllipsis"

export interface EventDetailDialogProps {
	event: UserEvent | null
	onOpenChange: (open: boolean) => void
}

// Compact detail affordance: the row only shows a label + timestamp, this surfaces the rest of the
// SAME already-fetched UserEvent object (ip/userAgent + whatever per-kind fields apply — file/folder
// name, receiver email, …) — see eventDetail.ts's header comment for why this never calls
// getUserEvent(uuid) again.
export function EventDetailDialog({ event, onOpenChange }: EventDetailDialogProps) {
	const { t } = useTranslation("settings")

	if (event === null) {
		return null
	}

	const { labelKey } = eventKindMeta(event.kind.type)
	const title = labelKey === "settingsEventUnknown" ? t(labelKey, { type: event.kind.type }) : t(labelKey)
	const rows = buildEventDetailRows(event, t)

	return (
		<Dialog
			open
			onOpenChange={onOpenChange}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>
						{new Date(Number(event.timestamp)).toLocaleString(undefined, { dateStyle: "full", timeStyle: "medium" })}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-2 text-sm">
					{rows.map(row => (
						<div
							key={row.title}
							className="flex items-start justify-between gap-4 border-b border-border/60 pb-2 last:border-b-0 last:pb-0"
						>
							<span className="shrink-0 text-muted-foreground">{row.title}</span>
							{row.opaque === true ? (
								<MiddleEllipsis
									value={row.value}
									className="min-w-0 text-right break-all"
								/>
							) : (
								<span className="min-w-0 truncate text-right break-all">{row.value}</span>
							)}
						</div>
					))}
				</div>
			</DialogContent>
		</Dialog>
	)
}
