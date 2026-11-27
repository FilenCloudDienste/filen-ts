import { useTranslation } from "react-i18next"
import { RepeatIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { TOGGLE_ON_CLASS } from "@/components/media/toggleOn"
import { MediaTooltip } from "@/components/media/video/stageButton"
import { toggleVideoRepeat, useVideoRepeat } from "@/lib/media/videoRepeat"

// The preview video player's repeat: whether the video plays again when it ends, kept across sessions.
// `tooltipContainer` is the element the player takes fullscreen.
export function RepeatButton({ tooltipContainer }: { tooltipContainer?: HTMLElement | null | undefined }) {
	const { t } = useTranslation("videos")
	const repeat = useVideoRepeat("preview")

	return (
		<MediaTooltip
			label={t("playerRepeat")}
			action="media.repeat"
			container={tooltipContainer}
		>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={t("playerRepeat")}
				aria-pressed={repeat}
				className={cn(TOGGLE_ON_CLASS, "@max-xs:hidden")}
				onClick={() => {
					toggleVideoRepeat("preview")
				}}
			>
				<RepeatIcon />
			</Button>
		</MediaTooltip>
	)
}
