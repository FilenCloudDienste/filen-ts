import { useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { cn, formatSecondsToMediaClock } from "@filen/shared"
import { SliderVisual } from "@/components/media/sliderVisual"
import { GLASS_SURFACE_CLASS } from "@/components/ui/surface"
import { chapterAt, type StageChapter } from "@/components/media/video/stage.logic"
import { MEDIA_SEEK_STEP_SECONDS } from "@/lib/media/mediaKeys.logic"
import { chapterName, parseBufferedRanges, percentOf, ratioAt, scrubberKeyTarget, timeAtRatio } from "@/lib/media/scrubber.logic"
import { seekMedia, useMediaBuffered, useMediaCurrentTime, useMediaDuration } from "@/lib/media/useMediaState"

interface MediaScrubberProps {
	// Seconds.
	value: number
	duration: number
	label: string
	onSeek: (seconds: number) => void
	// A relative key seek (the arrows, PageUp/PageDown), for a player that coalesces held keys; onSeek otherwise.
	onSeekBy?: ((delta: number) => void) | undefined
	// useMediaBuffered's snapshot.
	buffered?: string | undefined
	// The time under a drag as it moves, and null once it ends.
	onScrub?: ((seconds: number | null) => void) | undefined
	// Off where readouts beside the rail already say the time, and a tip would cover neighbouring controls.
	tooltip?: boolean | undefined
	// Start-ordered chapters: a tick at each start, and the tip names the chapter under the pointer.
	markers?: readonly StageChapter[] | undefined
	// What one arrow key moves, in the value's unit (MEDIA_SEEK_STEP_SECONDS by default).
	step?: number | undefined
	// The spoken value, for a scrubber over something other than time (an animation's frames).
	valueText?: ((value: number) => string) | undefined
	className?: string | undefined
}

// The seek slider every player shares. A drag previews where it would land and seeks once, on release,
// so a stream is asked for the bytes of one position instead of every one the pointer crossed. The
// range input underneath carries the value, the keyboard and the accessible name; the pointer is handled
// on the rail so the drawn fill and the pointer agree to the pixel.
export function MediaScrubber({
	value,
	duration,
	label,
	onSeek,
	onSeekBy,
	buffered,
	onScrub,
	tooltip,
	markers,
	step,
	valueText,
	className
}: MediaScrubberProps) {
	const { t } = useTranslation("common")
	const inputRef = useRef<HTMLInputElement>(null)
	const [dragTime, setDragTime] = useState<number | null>(null)
	const [hoverTime, setHoverTime] = useState<number | null>(null)
	const disabled = duration <= 0
	const shown = dragTime ?? Math.min(value, duration)
	const tipTime = tooltip === false ? null : (dragTime ?? hoverTime)
	const tipChapter = tipTime === null || markers === undefined ? null : chapterAt(markers, tipTime)
	const shownChapter = markers === undefined ? null : chapterAt(markers, shown)
	// Ticks inside the rail only: one at either end would only thicken its edge.
	const ticks =
		markers === undefined || disabled
			? undefined
			: markers.filter(marker => marker.start > 0.5 && marker.start < duration - 0.5).map(marker => percentOf(marker.start, duration))

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
		const target = scrubberKeyTarget(event.key, shown, duration, step ?? MEDIA_SEEK_STEP_SECONDS)

		if (target === null) {
			return
		}

		event.preventDefault()

		if (onSeekBy !== undefined && event.key !== "Home" && event.key !== "End") {
			onSeekBy(target - shown)
		} else {
			onSeek(target)
		}
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
				aria-valuetext={
					valueText !== undefined
						? valueText(shown)
						: shownChapter === null
							? t("mediaTimeOf", {
									current: formatSecondsToMediaClock(shown),
									total: formatSecondsToMediaClock(Math.max(duration, 0))
								})
							: t("mediaTimeOfInChapter", {
									current: formatSecondsToMediaClock(shown),
									total: formatSecondsToMediaClock(Math.max(duration, 0)),
									chapter: chapterName(markers ?? [], shownChapter, t)
								})
				}
				className="peer pointer-events-none absolute inset-0 size-full appearance-none opacity-0"
				onKeyDown={handleKeyDown}
				onChange={handleChange}
			/>
			<SliderVisual
				percent={percentOf(shown, duration)}
				segments={buffered !== undefined ? parseBufferedRanges(buffered) : undefined}
				duration={duration}
				thumbShown={dragTime !== null}
				ticks={ticks}
			/>
			{tipTime !== null && !disabled ? (
				<div
					aria-hidden="true"
					className={cn(
						"pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-lg px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-popover-foreground tabular-nums",
						GLASS_SURFACE_CLASS
					)}
					style={{ left: `${String(percentOf(tipTime, duration))}%` }}
				>
					{formatSecondsToMediaClock(tipTime)}
					{tipChapter === null ? null : (
						<span className="ml-1 inline-block max-w-48 truncate align-bottom text-muted-foreground">
							· {chapterName(markers ?? [], tipChapter, t)}
						</span>
					)}
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
	markers,
	className
}: {
	media: HTMLMediaElement | null
	label: string
	onScrub?: ((seconds: number | null) => void) | undefined
	markers?: readonly StageChapter[] | undefined
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
			markers={markers}
			className={className}
			onSeek={seconds => {
				if (media !== null) {
					seekMedia(media, seconds)
				}
			}}
		/>
	)
}
