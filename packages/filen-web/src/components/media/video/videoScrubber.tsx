import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { cn, formatSecondsToMediaClock } from "@filen/shared"
import { MEDIA_SEEK_STEP_SECONDS } from "@/lib/media/mediaKeys.logic"
import { chapterName, percentOf, ratioAt, timeAtRatio } from "@/lib/media/scrubber.logic"
import { chapterAt, type StageChapter } from "@/components/media/video/stage.logic"

// The player's full-width seek bar. The playhead, the time readouts and the buffered ranges are written
// straight into the DOM (transform: scaleX for the fill) from the element's own events, and from an
// animation frame loop only while the bar is on screen and playing: nothing re-renders as playback runs.
// Chapters cut thin gaps into the rail; hovering or dragging shows the time and the chapter's title.
// A drag seeks once, on release.

const BUFFER_SEGMENTS = 8

function mediaDuration(video: HTMLVideoElement): number {
	return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
}

export function VideoScrubber({
	video,
	visible,
	chapters,
	pendingTarget,
	remainingMode,
	label,
	onSeek,
	onSeekBy,
	onChapter,
	onScrub,
	onToggleRemaining,
	partLabel
}: {
	video: HTMLVideoElement | null
	// The controls are on screen.
	visible: boolean
	chapters: readonly StageChapter[]
	// A coalesced keyboard seek not applied yet: shown as the playhead meanwhile.
	pendingTarget: number | null
	remainingMode: boolean
	label: string
	onSeek: (seconds: number) => void
	onSeekBy: (seconds: number) => void
	onChapter: (direction: 1 | -1) => void
	onScrub: (scrubbing: boolean) => void
	onToggleRemaining: () => void
	partLabel?: string | null | undefined
}) {
	const { t } = useTranslation("videos")
	// The chapter names and the accessible value come from the shared scrubber strings.
	const { t: tCommon } = useTranslation("common")
	const inputRef = useRef<HTMLInputElement>(null)
	const fillRef = useRef<HTMLDivElement>(null)
	const thumbRef = useRef<HTMLDivElement>(null)
	const bufferedRef = useRef<HTMLDivElement>(null)
	const elapsedRef = useRef<HTMLSpanElement>(null)
	const totalRef = useRef<HTMLButtonElement>(null)
	const [duration, setDuration] = useState(0)
	const [dragTime, setDragTime] = useState<number | null>(null)
	const [hoverTime, setHoverTime] = useState<number | null>(null)
	// Only play and pause re-render, to start or stop the frame loop.
	const [paused, setPaused] = useState(true)
	const override = dragTime ?? pendingTarget

	useEffect(() => {
		if (video === null) {
			return
		}

		const element = video

		function update(): void {
			setPaused(element.paused)
		}

		update()
		element.addEventListener("play", update)
		element.addEventListener("pause", update)
		element.addEventListener("emptied", update)

		return () => {
			element.removeEventListener("play", update)
			element.removeEventListener("pause", update)
			element.removeEventListener("emptied", update)
		}
	}, [video])

	useEffect(() => {
		if (video === null) {
			return
		}

		const element = video
		let frame = 0
		let lastSecond = -1
		let lastRemaining = -1
		let lastValueSecond = -1

		function paint(): void {
			const total = mediaDuration(element)
			const time = override ?? element.currentTime
			const ratio = total > 0 ? Math.max(0, Math.min(1, time / total)) : 0

			if (fillRef.current !== null) {
				fillRef.current.style.transform = `scaleX(${String(ratio)})`
			}

			if (thumbRef.current !== null) {
				thumbRef.current.style.transform = `translateX(${String(ratio * 100)}%)`
			}

			const second = Math.floor(time)
			const remaining = Math.max(0, Math.round(total - time))

			if (second !== lastSecond && elapsedRef.current !== null) {
				lastSecond = second
				elapsedRef.current.textContent = formatSecondsToMediaClock(second)
			}

			if (remaining !== lastRemaining && totalRef.current !== null) {
				lastRemaining = remaining
				totalRef.current.textContent = remainingMode ? `-${formatSecondsToMediaClock(remaining)}` : formatSecondsToMediaClock(total)
			}

			// The accessible value follows once a second, not every frame.
			if (second !== lastValueSecond && inputRef.current !== null) {
				lastValueSecond = second

				const current = formatSecondsToMediaClock(time)
				const totalText = formatSecondsToMediaClock(total)
				const chapter = chapterAt(chapters, time)

				inputRef.current.value = String(time)
				inputRef.current.setAttribute(
					"aria-valuetext",
					chapter === null
						? tCommon("mediaTimeOf", { current, total: totalText })
						: tCommon("mediaTimeOfInChapter", { current, total: totalText, chapter: chapterName(chapters, chapter, tCommon) })
				)
			}
		}

		function paintBuffered(): void {
			const host = bufferedRef.current
			const total = mediaDuration(element)

			if (host === null) {
				return
			}

			const ranges = element.buffered
			let used = 0

			for (let i = 0; i < ranges.length && used < BUFFER_SEGMENTS && total > 0; i++) {
				const start = ranges.start(i)
				const end = Math.min(total, ranges.end(i))

				if (end <= start) {
					continue
				}

				const segment = host.children[used]

				if (segment instanceof HTMLElement) {
					segment.style.display = "block"
					segment.style.left = `${String((start / total) * 100)}%`
					segment.style.width = `${String(((end - start) / total) * 100)}%`
				}

				used++
			}

			for (let i = used; i < host.children.length; i++) {
				const segment = host.children[i]

				if (segment instanceof HTMLElement) {
					segment.style.display = "none"
				}
			}
		}

		function loop(): void {
			paint()
			frame = requestAnimationFrame(loop)
		}

		function sync(): void {
			setDuration(mediaDuration(element))
			paint()
			paintBuffered()
		}

		const running = visible && !paused && override === null

		paint()
		paintBuffered()
		setDuration(mediaDuration(element))

		if (running) {
			frame = requestAnimationFrame(loop)
		}

		// While hidden or paused, the element's own events are enough.
		const onTime = running ? null : paint

		element.addEventListener("durationchange", sync)
		element.addEventListener("loadedmetadata", sync)
		element.addEventListener("emptied", sync)
		element.addEventListener("seeked", paint)
		element.addEventListener("progress", paintBuffered)
		element.addEventListener("seeked", paintBuffered)

		if (onTime !== null) {
			element.addEventListener("timeupdate", onTime)
		}

		return () => {
			cancelAnimationFrame(frame)
			element.removeEventListener("durationchange", sync)
			element.removeEventListener("loadedmetadata", sync)
			element.removeEventListener("emptied", sync)
			element.removeEventListener("seeked", paint)
			element.removeEventListener("progress", paintBuffered)
			element.removeEventListener("seeked", paintBuffered)

			if (onTime !== null) {
				element.removeEventListener("timeupdate", onTime)
			}
		}
	}, [video, visible, paused, override, remainingMode, chapters, tCommon])

	const disabled = duration <= 0
	const bubbleTime = dragTime ?? hoverTime
	const bubbleChapter = bubbleTime === null ? null : chapterAt(chapters, bubbleTime)

	function timeAt(event: PointerEvent<HTMLDivElement>): number {
		const rect = event.currentTarget.getBoundingClientRect()

		return timeAtRatio(ratioAt(event.clientX, rect.left, rect.width), duration)
	}

	function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
		if (disabled || event.button !== 0) {
			return
		}

		event.preventDefault()
		event.currentTarget.setPointerCapture(event.pointerId)
		inputRef.current?.focus({ preventScroll: true })
		setDragTime(timeAt(event))
		onScrub(true)
	}

	function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
		if (disabled) {
			return
		}

		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			setDragTime(timeAt(event))
		} else if (event.pointerType === "mouse") {
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
		onScrub(false)
	}

	function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
		switch (event.key) {
			case "ArrowLeft":
			case "ArrowDown":
				onSeekBy(-MEDIA_SEEK_STEP_SECONDS)
				break
			case "ArrowRight":
			case "ArrowUp":
				onSeekBy(MEDIA_SEEK_STEP_SECONDS)
				break
			case "Home":
				onSeek(0)
				break
			case "End":
				onSeek(duration)
				break
			case "PageUp":
				onChapter(-1)
				break
			case "PageDown":
				onChapter(1)
				break
			default:
				return
		}

		event.preventDefault()
		event.stopPropagation()
	}

	return (
		<div className="flex w-full items-center gap-3">
			<span
				ref={elapsedRef}
				className="min-w-10 shrink-0 text-right text-xs font-medium text-white tabular-nums"
			>
				0:00
			</span>
			<div
				className={cn("group/slider relative flex h-6 min-w-0 flex-1 touch-none items-center", !disabled && "cursor-pointer")}
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
					defaultValue={0}
					disabled={disabled}
					aria-label={label}
					className="peer pointer-events-none absolute inset-0 size-full appearance-none opacity-0"
					onKeyDown={handleKeyDown}
					onChange={event => {
						onSeek(Number(event.target.value))
					}}
				/>
				<div
					aria-hidden="true"
					className="pointer-events-none relative h-1 w-full overflow-hidden rounded-full bg-white/25 transition-[height] duration-150 group-hover/slider:h-1.5 motion-reduce:transition-none"
				>
					<div
						ref={bufferedRef}
						className="absolute inset-0"
					>
						{Array.from({ length: BUFFER_SEGMENTS }, (_, index) => (
							<div
								key={index}
								className="absolute inset-y-0 hidden bg-white/30"
							/>
						))}
					</div>
					<div
						ref={fillRef}
						// Written as `transform` by the frame loop; Tailwind's scale utilities set `scale`, which would compound it.
						className="absolute inset-0 origin-left bg-white"
						style={{ transform: "scaleX(0)" }}
					/>
					{duration > 0
						? chapters.map(chapter =>
								chapter.start > 0.5 && chapter.start < duration - 0.5 ? (
									<div
										key={chapter.start}
										className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-black"
										style={{ left: `${String(percentOf(chapter.start, duration))}%` }}
									/>
								) : null
							)
						: null}
				</div>
				<div
					ref={thumbRef}
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 top-1/2 h-0"
				>
					<div
						className={cn(
							"absolute top-0 left-0 size-3.5 -translate-1/2 rounded-full bg-white shadow transition-opacity duration-150 group-hover/slider:opacity-100 peer-focus-visible:opacity-100 motion-reduce:transition-none",
							dragTime === null ? "opacity-0" : "opacity-100"
						)}
					/>
				</div>
				{bubbleTime !== null && !disabled ? (
					<div
						aria-hidden="true"
						className="pointer-events-none absolute bottom-full mb-2 flex -translate-x-1/2 items-center gap-1.5 rounded-lg bg-neutral-950/85 px-2 py-1 text-xs font-medium whitespace-nowrap text-white tabular-nums ring-1 ring-white/15"
						style={{ left: `${String(percentOf(bubbleTime, duration))}%` }}
					>
						{formatSecondsToMediaClock(bubbleTime)}
						{bubbleChapter === null ? null : (
							<span className="max-w-48 truncate text-white/70">· {chapterName(chapters, bubbleChapter, tCommon)}</span>
						)}
					</div>
				) : null}
			</div>
			{partLabel === null || partLabel === undefined ? null : (
				<span className="shrink-0 rounded-full bg-white/15 px-2 py-0.5 text-xs text-white">{partLabel}</span>
			)}
			<button
				ref={totalRef}
				type="button"
				aria-label={remainingMode ? t("playerShowTotal") : t("playerShowRemaining")}
				className="min-w-12 shrink-0 rounded-md text-left text-xs font-medium text-white/80 tabular-nums outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white/60"
				onClick={onToggleRemaining}
			>
				0:00
			</button>
		</div>
	)
}
