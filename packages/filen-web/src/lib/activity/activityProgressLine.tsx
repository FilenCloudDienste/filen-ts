import { useTranslation } from "react-i18next"
import { Progress } from "@/components/ui/progress"
import { useActivityStore } from "@/lib/activity/activityStore"
import { progressPercent, showsProgress } from "@/lib/activity/activity.logic"
import { percentFormat } from "@/features/transfers/components/transferRow.logic"

// A running activity's bar and figure ("5 of 12", "41%"), read live so a tick never re-issues its toast.
export function ActivityProgressLine({ id }: { id: string }) {
	const { t, i18n } = useTranslation("common")
	const progress = useActivityStore(state => state.progress[id])

	if (!showsProgress(progress)) {
		return null
	}

	const percent = progressPercent(progress)

	return (
		<div className="mt-1.5 flex items-center gap-2">
			<Progress
				value={percent}
				aria-label={t("activityProgress")}
				className="min-w-0 flex-1 gap-0"
			/>
			<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
				{progress.kind === "count"
					? t("activityProgressCount", { settled: progress.settled, total: progress.total })
					: percentFormat(i18n.language).format(Math.floor(percent) / 100)}
			</span>
		</div>
	)
}
