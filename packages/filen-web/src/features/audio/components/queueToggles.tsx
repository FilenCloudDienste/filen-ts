import { useTranslation } from "react-i18next"
import { Shuffle, Repeat, Repeat1 } from "lucide-react"
import { audioEngine } from "@/features/audio/lib/audioEngine"
import { useAudioStore } from "@/features/audio/store/useAudioStore"
import type { LoopMode } from "@/features/audio/store/audioQueue"
import { nextLoopMode } from "@/features/audio/components/audioTransport.logic"
import { Button } from "@/components/ui/button"
import { cn } from "@filen/shared"

const LOOP_LABEL_KEYS = {
	off: "loopOff",
	all: "loopAll",
	one: "loopOne"
} as const satisfies Record<LoopMode, string>

// Blue, as on mobile: --primary is a neutral a hair off --foreground, so an "on" tinted with it read as off.
// Keyed on aria-pressed so it also outranks the ghost variant's hover/aria-expanded foreground.
export const TOGGLE_ON_CLASS = "aria-pressed:text-blue-500"

// Shared by the player bar and the now-playing panel. Each reads only its own store field, so a toggle
// re-renders itself rather than its host surface.
export function ShuffleToggleButton({ className }: { className?: string }) {
	const { t } = useTranslation("audio")
	const shuffleEnabled = useAudioStore(state => state.shuffleEnabled)

	return (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label={t("shuffle")}
			aria-pressed={shuffleEnabled}
			className={cn(TOGGLE_ON_CLASS, className)}
			onClick={() => {
				audioEngine.setShuffleEnabled(!shuffleEnabled)
			}}
		>
			<Shuffle />
		</Button>
	)
}

export function LoopToggleButton({ className }: { className?: string }) {
	const { t } = useTranslation("audio")
	const loopMode = useAudioStore(state => state.loopMode)

	return (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label={t(LOOP_LABEL_KEYS[loopMode])}
			aria-pressed={loopMode !== "off"}
			className={cn(TOGGLE_ON_CLASS, className)}
			onClick={() => {
				audioEngine.setLoopMode(nextLoopMode(loopMode))
			}}
		>
			{loopMode === "one" ? <Repeat1 /> : <Repeat />}
		</Button>
	)
}
