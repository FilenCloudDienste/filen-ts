import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Volume1Icon, Volume2Icon, VolumeXIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { SliderVisual } from "@/components/media/sliderVisual"
import { MediaTooltip } from "@/components/media/video/stageButton"
import { MEDIA_VOLUME_STEP } from "@/lib/media/mediaKeys.logic"
import { setMediaVolume, stepMediaVolume, toggleMediaMuted, useMediaVolumeStore, warmMediaVolume } from "@/lib/media/mediaVolume"

// The arrow keys on the slider move by the players' volume step, as the media keys do.
const VOLUME_KEY_DIRECTION: Partial<Record<string, 1 | -1>> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }

// Mute toggle plus level slider over the shared media volume, so every player shows and sets the same
// level. The slider writes the store on every step; the store itself debounces the persisted write.
// `muteAction` is the host's mute key, named in the tooltip; `tooltipContainer` the element a player takes fullscreen.
export function VolumeControl({
	className,
	sliderClassName,
	muteAction,
	tooltipContainer
}: {
	className?: string | undefined
	sliderClassName?: string | undefined
	muteAction?: string | undefined
	tooltipContainer?: HTMLElement | null | undefined
}) {
	const { t } = useTranslation(["audio", "common"])
	const volume = useMediaVolumeStore(state => state.volume)
	const muted = useMediaVolumeStore(state => state.muted)
	const level = muted ? 0 : volume
	const muteLabel = muted ? t("unmute") : t("mute")

	useEffect(() => {
		void warmMediaVolume()
	}, [])

	return (
		<div className={cn("flex shrink-0 items-center gap-1", className)}>
			<MediaTooltip
				label={muteLabel}
				action={muteAction}
				container={tooltipContainer}
			>
				<Button
					variant="ghost"
					size="icon-sm"
					// The flipping label carries the state; aria-pressed on top would announce "Unmute, pressed".
					aria-label={muteLabel}
					onClick={toggleMediaMuted}
				>
					{level === 0 ? <VolumeXIcon /> : level < 0.5 ? <Volume1Icon /> : <Volume2Icon />}
				</Button>
			</MediaTooltip>
			{/* The margin keeps the thumb, which overhangs the rail's ends, clear of the controls beside it. */}
			<div className={cn("group/slider relative mx-1.5 flex h-5 w-20 items-center", sliderClassName)}>
				<input
					type="range"
					min={0}
					max={1}
					// Dragging sets any level; the arrow keys keep the players' volume step.
					step="any"
					value={level}
					aria-label={t("volume")}
					aria-valuetext={t("common:mediaVolumePercent", { percent: Math.round(level * 100) })}
					// A zero-width thumb makes the native pointer mapping match the drawn fill exactly.
					className="peer absolute inset-0 z-10 size-full cursor-pointer appearance-none bg-transparent opacity-0 [&::-moz-range-thumb]:size-0 [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:size-0 [&::-webkit-slider-thumb]:appearance-none"
					onChange={event => {
						setMediaVolume(Number(event.target.value))
					}}
					onKeyDown={event => {
						const direction = VOLUME_KEY_DIRECTION[event.key]

						if (direction === undefined) {
							return
						}

						event.preventDefault()
						stepMediaVolume(direction * MEDIA_VOLUME_STEP)
					}}
				/>
				<SliderVisual percent={level * 100} />
			</div>
		</div>
	)
}
