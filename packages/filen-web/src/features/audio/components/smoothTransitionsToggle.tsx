import { useEffect, useId } from "react"
import { useTranslation } from "react-i18next"
import { Blend } from "lucide-react"
import { useShallow } from "zustand/shallow"
import { hydrateSmoothTransitionsPrefs, useSmoothTransitionsStore } from "@/features/audio/store/useSmoothTransitionsStore"
import {
	SMOOTH_TRANSITIONS_UNAVAILABLE_KEYS,
	smoothTransitionsLocked,
	toggleSmoothTransitionsByUser
} from "@/features/audio/lib/smoothTransitionsUi"
import { TOGGLE_ON_CLASS } from "@/features/audio/components/queueToggles"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@filen/shared"

// Beside Shuffle and Repeat, in their style; a 44 px target on a phone's touch screen. The tooltip names the blend
// length; while the feature is unavailable it says why instead, and the button stays hoverable (aria-disabled) so it
// can.
export function SmoothTransitionsToggleButton({ className }: { className?: string }) {
	const { t } = useTranslation("audio")
	const { enabled, fadeSeconds, unavailable } = useSmoothTransitionsStore(
		useShallow(state => ({
			enabled: state.prefs.enabled,
			fadeSeconds: state.prefs.fadeSeconds,
			unavailable: state.unavailable
		}))
	)
	const reasonId = useId()
	const reason = unavailable === null ? null : t(SMOOTH_TRANSITIONS_UNAVAILABLE_KEYS[unavailable])

	useEffect(() => {
		void hydrateSmoothTransitionsPrefs()
	}, [])

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("smoothTransitions")}
						aria-pressed={enabled}
						aria-describedby={reason === null ? undefined : reasonId}
						disabled={smoothTransitionsLocked({ enabled, unavailable })}
						focusableWhenDisabled
						className={cn(TOGGLE_ON_CLASS, "aria-disabled:opacity-50 max-sm:pointer-coarse:size-11", className)}
						onClick={toggleSmoothTransitionsByUser}
					>
						<Blend />
						{reason === null ? null : (
							<span
								id={reasonId}
								className="sr-only"
							>
								{reason}
							</span>
						)}
					</Button>
				}
			/>
			<TooltipContent>{reason ?? t("smoothTransitionsTooltip", { count: fadeSeconds })}</TooltipContent>
		</Tooltip>
	)
}
