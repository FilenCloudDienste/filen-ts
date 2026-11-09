import { useTranslation } from "react-i18next"
import { cn, formatBytes } from "@filen/shared"
import { Skeleton } from "@/components/ui/skeleton"
import { SettingsBlock } from "@/features/settings/components/settingsLayout"
import type { CacheRow } from "@/features/settings/lib/localCaches"
import { rowLabel } from "@/features/settings/lib/storageActions"

export type UsageSegmentId = CacheRow | "other"

export interface UsageSegment {
	id: UsageSegmentId
	bytes: number
}

// The theme is neutral, so parts are told apart by fixed steps of the foreground ink (bound to the part, never to its
// rank) with a surface gap between them; the legend names each one.
const SEGMENT_FILL_CLASS: Record<UsageSegmentId, string> = {
	thumbnails: "bg-foreground/85",
	videos: "bg-foreground/65",
	music: "bg-foreground/50",
	queryCache: "bg-foreground/38",
	model: "bg-foreground/28",
	browserCache: "bg-foreground/20",
	networkDrive: "bg-foreground/14",
	other: "bg-foreground/8"
}

interface StorageUsageBarProps {
	label: string
	// Undefined while anything is still measured.
	total: number | undefined
	segments: readonly UsageSegment[]
}

function segmentLabel(id: UsageSegmentId, otherLabel: string): string {
	return id === "other" ? otherLabel : rowLabel(id)
}

function StorageUsageBar({ label, total, segments }: StorageUsageBarProps) {
	const { t } = useTranslation("settings")
	const otherLabel = t("storageOther")
	const segmentTotal = segments.reduce((sum, segment) => sum + segment.bytes, 0)

	return (
		<SettingsBlock className="flex flex-col gap-3">
			<div className="flex items-baseline justify-between gap-4">
				<p className="text-sm font-medium">{label}</p>
				{total === undefined ? (
					<Skeleton className="h-4 w-16" />
				) : (
					<p className="text-sm font-medium tabular-nums">{formatBytes(total)}</p>
				)}
			</div>
			{total === undefined ? (
				<Skeleton className="h-2 w-full rounded-2xl" />
			) : (
				<div
					aria-hidden="true"
					className="flex h-2 w-full gap-0.5 overflow-hidden rounded-2xl bg-muted"
				>
					{segments.map(segment => (
						<div
							key={segment.id}
							title={`${segmentLabel(segment.id, otherLabel)}: ${formatBytes(segment.bytes)}`}
							className={cn("h-full min-w-px", SEGMENT_FILL_CLASS[segment.id])}
							style={{ flexGrow: segment.bytes / segmentTotal, flexBasis: 0 }}
						/>
					))}
				</div>
			)}
			{segments.length > 0 ? (
				<ul
					aria-label={t("storageBarLabel")}
					className="flex flex-wrap gap-x-5 gap-y-1.5"
				>
					{segments.map(segment => (
						<li
							key={segment.id}
							className="flex items-center gap-2 text-sm"
						>
							<span className={cn("size-2.5 shrink-0 rounded-full", SEGMENT_FILL_CLASS[segment.id])} />
							<span className="text-muted-foreground">{segmentLabel(segment.id, otherLabel)}</span>
							<span className="tabular-nums">{formatBytes(segment.bytes)}</span>
						</li>
					))}
				</ul>
			) : null}
		</SettingsBlock>
	)
}

export { StorageUsageBar }
