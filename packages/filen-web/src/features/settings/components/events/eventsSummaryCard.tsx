import { useId, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import { formatRelativeTime } from "@/lib/relativeTime"
import { securitySummary, type EventDescriber } from "@/features/settings/lib/eventModel"
import type { EventEntry } from "@/features/settings/lib/eventsPagination"
import { CARD_SURFACE_CLASS } from "@/components/ui/surface"

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

// Stands in while what would answer an item may still be in a page not loaded yet.
const PENDING = "—"

export interface EventsSummaryCardProps {
	entries: readonly EventEntry[]
	oldest: bigint | undefined
	// Every page of the 30-day window is loaded, so an absence is a real one.
	complete: boolean
	describer: EventDescriber
	now: number
}

function SummaryItem({
	label,
	value,
	detail,
	warning
}: {
	label: string
	value: ReactNode
	detail?: string | undefined
	warning?: boolean
}) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			{/* Labels and details wrap: two narrow columns on a phone would cut them off mid-word. */}
			<dt className="text-xs break-words text-muted-foreground">{label}</dt>
			<dd className={cn("truncate font-medium", warning === true && "text-warning-foreground")}>{value}</dd>
			{detail !== undefined ? <dd className="text-xs break-words text-muted-foreground">{detail}</dd> : null}
		</div>
	)
}

// "Security at a glance": the latest sign-in, recent failed ones, and the latest password and two-factor
// changes, all read from the loaded events.
export function EventsSummaryCard({ entries, oldest, complete, describer, now }: EventsSummaryCardProps) {
	const { t } = useTranslation("events")
	const { t: tCommon } = useTranslation("common")
	const titleId = useId()
	const summary = securitySummary(entries, now)
	const lastLogin = summary.lastLogin === undefined ? undefined : describer.describe(summary.lastLogin)
	// The count is exact once the loaded events reach back a week; a partial one still warns.
	const failedCovered = complete || (oldest !== undefined && Number(oldest) <= now - SEVEN_DAYS_MS)
	const absent = complete ? t("eventsSummaryNotInWindow") : PENDING
	const relative = (timestamp: bigint) => formatRelativeTime(Number(timestamp), tCommon, now)

	return (
		<section
			aria-labelledby={titleId}
			className={cn(CARD_SURFACE_CLASS, "flex shrink-0 flex-col gap-3 p-4")}
		>
			<h2
				id={titleId}
				className="font-heading text-sm font-medium"
			>
				{t("eventsSummaryTitle")}
			</h2>
			<dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
				<SummaryItem
					label={t("eventsSummaryLastSignIn")}
					value={lastLogin?.deviceLabel ?? (complete ? t("eventsSummaryNoSignIn") : PENDING)}
					detail={
						summary.lastLogin === undefined
							? undefined
							: [lastLogin?.ip, relative(summary.lastLogin.timestamp)].filter(part => part !== undefined).join(" · ")
					}
				/>
				<SummaryItem
					label={t("eventsSummaryFailedSignIns")}
					value={
						summary.failedLast7d > 0
							? t("eventsSummaryFailedSignInsCount", { count: summary.failedLast7d })
							: failedCovered
								? t("eventsSummaryFailedSignInsNone")
								: PENDING
					}
					warning={summary.failedLast7d > 0}
				/>
				<SummaryItem
					label={t("eventsSummaryPassword")}
					value={
						summary.lastPasswordChange === undefined
							? absent
							: `${t("eventsSummaryPasswordChanged")} · ${relative(summary.lastPasswordChange.timestamp)}`
					}
				/>
				<SummaryItem
					label={t("eventsSummaryTwoFactor")}
					value={
						summary.last2faChange === undefined
							? absent
							: `${t(summary.last2faChange.enabled ? "eventsSummaryTwoFactorEnabled" : "eventsSummaryTwoFactorDisabled")} · ${relative(
									summary.last2faChange.entry.timestamp
								)}`
					}
				/>
			</dl>
		</section>
	)
}
