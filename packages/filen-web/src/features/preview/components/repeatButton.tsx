import { useTranslation } from "react-i18next"
import { RepeatIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { TOGGLE_ON_CLASS } from "@/components/media/toggleOn"
import { toggleVideoRepeat, useVideoRepeat } from "@/lib/media/videoRepeat"

// The preview video player's repeat: whether the video plays again when it ends, kept across sessions.
export function RepeatButton() {
	const { t } = useTranslation("videos")
	const repeat = useVideoRepeat("preview")

	return (
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
	)
}
