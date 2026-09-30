import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Volume1Icon, Volume2Icon, VolumeXIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { SliderVisual } from "@/components/media/sliderVisual"
import { VOLUME_STEP } from "@/lib/media/playerKeys.logic"
import { setMediaVolume, toggleMediaMuted, useMediaVolumeStore, warmMediaVolume } from "@/lib/media/mediaVolume"

// Mute toggle plus level slider over the shared media volume, so every player shows and sets the same
// level. The slider writes the store on every step; the store itself debounces the persisted write.
export function VolumeControl({ className, sliderClassName }: { className?: string | undefined; sliderClassName?: string | undefined }) {
	const { t } = useTranslation(["audio", "common"])
	const volume = useMediaVolumeStore(state => state.volume)
	const muted = useMediaVolumeStore(state => state.muted)
	const level = muted ? 0 : volume

	useEffect(() => {
		void warmMediaVolume()
	}, [])

	return (
		<div className={cn("flex shrink-0 items-center gap-1", className)}>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={muted ? t("unmute") : t("mute")}
				aria-pressed={muted}
				onClick={toggleMediaMuted}
			>
				{level === 0 ? <VolumeXIcon /> : level < 0.5 ? <Volume1Icon /> : <Volume2Icon />}
			</Button>
			{/* The margin keeps the thumb, which overhangs the rail's ends, clear of the controls beside it. */}
			<div className={cn("group/slider relative mx-1.5 flex h-5 w-20 items-center", sliderClassName)}>
				<input
					type="range"
					min={0}
					max={1}
					step={VOLUME_STEP}
					value={level}
					aria-label={t("volume")}
					aria-valuetext={t("common:mediaVolumePercent", { percent: Math.round(level * 100) })}
					// A zero-width thumb makes the native pointer mapping match the drawn fill exactly.
					className="peer absolute inset-0 z-10 size-full cursor-pointer appearance-none bg-transparent opacity-0 [&::-moz-range-thumb]:size-0 [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:size-0 [&::-webkit-slider-thumb]:appearance-none"
					onChange={event => {
						setMediaVolume(Number(event.target.value))
					}}
				/>
				<SliderVisual percent={level * 100} />
			</div>
		</div>
	)
}
