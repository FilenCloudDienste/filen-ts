import { useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { cn, formatSecondsToMediaClock } from "@filen/shared"
import { SliderVisual } from "@/components/media/sliderVisual"
import { GLASS_SURFACE_CLASS } from "@/components/ui/surface"
import { parseBufferedRanges, percentOf, ratioAt, scrubberKeyTarget, SEEK_STEP_SECONDS, timeAtRatio } from "@/lib/media/scrubber.logic"
import { seekMedia, useMediaBuffered, useMediaCurrentTime, useMediaDuration } from "@/lib/media/useMediaState"

interface MediaScrubberProps {
	// Seconds.
	value: number
	duration: number
	label: string
	onSeek: (seconds: number) => void
	// useMediaBuffered's snapshot.
	buffered?: string | undefined
	// The time under a drag as it moves, and null once it ends.
	onScrub?: ((seconds: number | null) => void) | undefined
	// Off where readouts beside the rail already say the time, and a tip would cover neighbouring controls.
	tooltip?: boolean | undefined
	className?: string | undefined
}

// The seek slider every player shares. A drag previews where it would land and seeks once, on release,
// so a stream is asked for the bytes of one position instead of every one the pointer crossed. The
// range input underneath carries the value, the keyboard and the accessible name; the pointer is handled
// on the rail so the drawn fill and the pointer agree to the pixel.
export function MediaScrubber({ value, duration, label, onSeek, buffered, onScrub, tooltip, className }: MediaScrubberProps) {
	const { t } = useTranslation("common")
	const inputRef = useRef<HTMLInputElement>(null)
	const [dragTime, setDragTime] = useState<number | null>(null)
	const [hoverTime, setHoverTime] = useState<number | null>(null)
	const disabled = duration <= 0
	const shown = dragTime ?? Math.min(value, duration)
	const tipTime = tooltip === false ? null : (dragTime ?? hoverTime)

	function timeAt(event: PointerEvent<HTMLDivElement>): number {
		const rect = event.currentTarget.getBoundingClientRect()

		return timeAtRatio(ratioAt(event.clientX, rect.left, rect.width), duration)
	}

	function drag(seconds: number): void {
		setDragTime(seconds)
		onScrub?.(seconds)
	}

	function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
		if (disabled || event.button !== 0) {
			return
		}

		// Keeps the text under the rail from being selected by the drag; focus is given by hand instead.
		event.preventDefault()
		event.currentTarget.setPointerCapture(event.pointerId)
		inputRef.current?.focus({ preventScroll: true })
		drag(timeAt(event))
	}

	function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
		if (disabled) {
			return
		}

		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			drag(timeAt(event))
		} else if (event.pointerType === "mouse" && tooltip !== false) {
			setHoverTime(timeAt(event))
		}
	}

	function endDrag(event: PointerEvent<HTMLDivElement>, commit: boolean): void {
		if (dragTime === null) {
			return
		}

		if (commit) {
			onSeek(timeAt(event))
		}

		setDragTime(null)
		onScrub?.(null)
	}

	function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
		const target = scrubberKeyTarget(event.key, shown, duration, SEEK_STEP_SECONDS)

		if (target === null) {
			return
		}

		event.preventDefault()
		onSeek(target)
	}

	// Only an assistive technology's own increment reaches here: the keys and the pointer are handled above.
	function handleChange(event: ChangeEvent<HTMLInputElement>): void {
		onSeek(Number(event.target.value))
	}

	return (
		<div
			className={cn("group/slider relative flex h-5 min-w-0 touch-none items-center", !disabled && "cursor-pointer", className)}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={event => {
				endDrag(event, true)
			}}
			onPointerCancel={event => {
				endDrag(event, false)
			}}
			onPointerLeave={() => {
				setHoverTime(null)
			}}
		>
			<input
				ref={inputRef}
				type="range"
				min={0}
				max={Math.max(duration, 0)}
				step="any"
				value={shown}
				disabled={disabled}
				aria-label={label}
				aria-valuetext={t("mediaTimeOf", {
					current: formatSecondsToMediaClock(shown),
					total: formatSecondsToMediaClock(Math.max(duration, 0))
				})}
				className="peer pointer-events-none absolute inset-0 size-full appearance-none opacity-0"
				onKeyDown={handleKeyDown}
				onChange={handleChange}
			/>
			<SliderVisual
				percent={percentOf(shown, duration)}
				segments={buffered !== undefined ? parseBufferedRanges(buffered) : undefined}
				duration={duration}
				thumbShown={dragTime !== null}
			/>
			{tipTime !== null && !disabled ? (
				<div
					aria-hidden="true"
					className={cn(
						"pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-lg px-1.5 py-0.5 text-xs font-medium text-popover-foreground tabular-nums",
						GLASS_SURFACE_CLASS
					)}
					style={{ left: `${String(percentOf(tipTime, duration))}%` }}
				>
					{formatSecondsToMediaClock(tipTime)}
				</div>
			) : null}
		</div>
	)
}

// The scrubber bound to a media element: only this component re-renders as the playhead moves.
export function MediaElementScrubber({
	media,
	label,
	onScrub,
	className
}: {
	media: HTMLMediaElement | null
	label: string
	onScrub?: ((seconds: number | null) => void) | undefined
	className?: string | undefined
}) {
	const currentTime = useMediaCurrentTime(media)
	const duration = useMediaDuration(media)
	const buffered = useMediaBuffered(media)

	return (
		<MediaScrubber
			value={currentTime}
			duration={duration}
			buffered={buffered}
			label={label}
			onScrub={onScrub}
			className={className}
			onSeek={seconds => {
				if (media !== null) {
					seekMedia(media, seconds)
				}
			}}
		/>
	)
}
