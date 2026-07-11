import { useTranslation } from "react-i18next"
import type { UserEvent } from "@filen/sdk-rs"
import { eventKindMeta } from "@/features/settings/lib/eventKind"

export interface EventRowProps {
	event: UserEvent
	onOpen: (event: UserEvent) => void
}

// One virtualized row: icon + human-readable label (eventKindMeta) + absolute timestamp. The whole row
// opens the compact detail dialog (EventDetailDialog) — there is no per-row menu, matching how thin
// this row is on mobile (a plain ListRow → alert).
export function EventRow({ event, onOpen }: EventRowProps) {
	const { t } = useTranslation("settings")
	const { labelKey, icon: Icon } = eventKindMeta(event.kind.type)
	const label = labelKey === "settingsEventUnknown" ? t(labelKey, { type: event.kind.type }) : t(labelKey)

	return (
		<button
			type="button"
			onClick={() => {
				onOpen(event)
			}}
			className="flex h-full w-full items-center gap-3 rounded-xl px-2.5 text-left transition-colors hover:bg-sidebar-accent/60"
		>
			<span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-4">
				<Icon aria-hidden="true" />
			</span>
			<span className="min-w-0 flex-1 truncate text-sm">{label}</span>
			<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
				{new Date(Number(event.timestamp)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
			</span>
		</button>
	)
}
