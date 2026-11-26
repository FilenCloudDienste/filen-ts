import { useTranslation } from "react-i18next"
import { RepeatIcon } from "lucide-react"
import { StageIconButton } from "@/components/media/video/stageButton"
import { TOGGLE_ON_CLASS } from "@/components/media/toggleOn"
import { toggleVideoRepeat, useVideoRepeat } from "@/lib/media/videoRepeat"

// The Videos player's repeat: whether the item plays again when it ends, kept across sessions.
export function RepeatButton() {
	const { t } = useTranslation("videos")
	const repeat = useVideoRepeat("videos")

	return (
		<StageIconButton
			label={t("playerRepeat")}
			action="media.repeat"
			pressed={repeat}
			className={TOGGLE_ON_CLASS}
			onClick={() => {
				toggleVideoRepeat("videos")
			}}
		>
			<RepeatIcon className="size-5" />
		</StageIconButton>
	)
}
