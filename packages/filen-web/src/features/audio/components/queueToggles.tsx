import { useTranslation } from "react-i18next"
import { Shuffle, Repeat, Repeat1 } from "lucide-react"
import { audioEngine } from "@/features/audio/lib/audioEngine"
import { useAudioStore } from "@/features/audio/store/useAudioStore"
import type { LoopMode } from "@/features/audio/store/audioQueue"
import { nextLoopMode } from "@/features/audio/components/audioTransport.logic"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { Kbd } from "@/lib/keymap/kbd"
import { TOGGLE_ON_CLASS } from "@/components/media/toggleOn"
import { cn } from "@filen/shared"

const LOOP_LABEL_KEYS = {
	off: "loopOff",
	all: "loopAll",
	one: "loopOne"
} as const satisfies Record<LoopMode, string>

// Every control of the now-playing panel: 44 px under a coarse pointer.
export const NOW_PLAYING_CONTROL_CLASS = "pointer-coarse:size-11"

// Shared by the player bar and the now-playing panel. Each reads only its own store field, so a toggle
// re-renders itself rather than its host surface.
export function ShuffleToggleButton({ className }: { className?: string }) {
	const { t } = useTranslation("audio")
	const shuffleEnabled = useAudioStore(state => state.shuffleEnabled)

	return (
		<TooltipIconButton
			label={t("shuffle")}
			pressed={shuffleEnabled}
			shortcut={<Kbd action="audio.shuffle" />}
			className={cn(TOGGLE_ON_CLASS, className)}
			onClick={() => {
				audioEngine.setShuffleEnabled(!shuffleEnabled)
			}}
		>
			<Shuffle />
		</TooltipIconButton>
	)
}

export function LoopToggleButton({ className }: { className?: string }) {
	const { t } = useTranslation("audio")
	const loopMode = useAudioStore(state => state.loopMode)

	return (
		<TooltipIconButton
			label={t(LOOP_LABEL_KEYS[loopMode])}
			pressed={loopMode !== "off"}
			shortcut={<Kbd action="audio.loop" />}
			className={cn(TOGGLE_ON_CLASS, className)}
			onClick={() => {
				audioEngine.setLoopMode(nextLoopMode(loopMode))
			}}
		>
			{loopMode === "one" ? <Repeat1 /> : <Repeat />}
		</TooltipIconButton>
	)
}
