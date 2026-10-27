import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { useShallow } from "zustand/shallow"
import { ArrowDownUpIcon, CheckIcon, CircleAlertIcon } from "lucide-react"
import { cn, formatBytesPerSecond } from "@filen/shared"
import { computeTransfersSpeed, useSpeedSampleAging, useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { transfersRingState } from "@/features/transfers/screens/transfers.logic"
import { RAIL_ITEM_BOX_CLASS, railItemStateClass } from "@/features/shell/lib/railItem"
import { RailStatusDot, RailTooltipDetail } from "@/features/shell/components/railProgressBar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

// The footer's transfers button: a ring of the aggregate progress around the transfers glyph, a check once
// everything finished, an alert glyph and a red ring once nothing runs and something failed (a dot while
// others still run). transfersRingState holds the visibility rule.
export function TransfersRing({ active }: { active: boolean }) {
	const { t } = useTranslation(["common", "transfers"])
	const { visible, empty, activeCount, percent, failed } = useTransfersStore(
		useShallow(state => transfersRingState(state.transfers, active))
	)
	// The samples, not the speed: the speed reads the clock, which a store selector must not.
	const speedSamples = useTransfersStore(state => state.speedSamples)

	// Ticks in the always-mounted rail, not only on /transfers: a paused or stalled transfer writes nothing
	// more, so without the tick the tooltip would keep its last speed on every other screen.
	useSpeedSampleAging()

	if (!visible) {
		return null
	}

	const running = activeCount > 0
	const failedOnly = !running && failed
	const ariaLabel = empty
		? t("common:moduleTransfers")
		: running
			? t("transfers:transfersActiveBadge", { count: activeCount })
			: failed
				? t("transfers:transfersRingFailed")
				: t("transfers:transfersRingDone")
	const detail = empty
		? null
		: running
			? formatBytesPerSecond(computeTransfersSpeed(speedSamples))
			: failed
				? t("transfers:transfersRingFailedDetail")
				: t("transfers:transfersRingDoneDetail")
	const Glyph = running || empty ? ArrowDownUpIcon : failed ? CircleAlertIcon : CheckIcon

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Link
						to="/transfers"
						aria-current={active ? "page" : undefined}
						aria-label={ariaLabel}
						className={cn(RAIL_ITEM_BOX_CLASS, "relative", railItemStateClass(active))}
					>
						<svg
							viewBox="0 0 36 36"
							aria-hidden="true"
							className="absolute inset-0 size-full -rotate-90"
						>
							<circle
								cx="18"
								cy="18"
								r="14"
								fill="none"
								strokeWidth="2.5"
								className="stroke-foreground/15"
							/>
							<circle
								cx="18"
								cy="18"
								r="14"
								fill="none"
								strokeWidth="2.5"
								strokeLinecap={percent > 0 ? "round" : "butt"}
								pathLength={100}
								strokeDasharray={`${String(percent)} 100`}
								className={cn(
									"transition-[stroke-dasharray] duration-300 ease-out",
									failedOnly ? "stroke-destructive" : "stroke-primary"
								)}
							/>
						</svg>
						<Glyph className={cn("size-4 shrink-0", failedOnly && "text-destructive")} />
						{running && failed ? (
							<RailStatusDot
								dot="attention"
								className="absolute top-0.5 right-0.5 ring-2 ring-canvas"
							/>
						) : null}
					</Link>
				}
			/>
			<TooltipContent side="right">
				{t("common:moduleTransfers")}
				{detail === null ? null : <RailTooltipDetail>{detail}</RailTooltipDetail>}
			</TooltipContent>
		</Tooltip>
	)
}
