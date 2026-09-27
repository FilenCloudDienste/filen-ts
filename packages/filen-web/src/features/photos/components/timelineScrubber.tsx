import { useEffect, useRef, useState, type PointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { KEEP_SELECTION_PROPS } from "@/features/drive/lib/clickAway.logic"
import { cn } from "@filen/shared"
import { formatTimelineMonthName, timelineHeaderAt, timelineYearMarks, type PhotosTimeline } from "@/features/photos/lib/timeline"

// Vertical room one year label needs; a year closer to the previous label than this goes unlabeled.
const LABEL_MIN_GAP_PX = 18
// Keeps the handle and the end labels clear of the rail's ends.
const TRACK_INSET_PX = 12
// How long the month pill stays up after the last scroll event.
const SCROLL_PILL_LINGER_MS = 900

// Stands in for the grid's scrollbar (hidden while this rail is shown): a track spanning the whole
// scroll range, a tick where each year begins, and a handle at the current position. While the grid
// scrolls, or the rail is hovered or dragged, a pill beside the handle (or the pointer) names the
// month there. A press or drag jumps. Mouse and pen only; keyboard users keep the grid's own keys and
// the scroll container's Page Up/Down, and touch keeps native scrolling.
export function TimelineScrubber({ timeline, scrollElement }: { timeline: PhotosTimeline; scrollElement: HTMLDivElement }) {
	const { i18n } = useTranslation()
	const railRef = useRef<HTMLDivElement>(null)
	const [railHeight, setRailHeight] = useState(0)
	const [scrollTop, setScrollTop] = useState(scrollElement.scrollTop)
	const [viewportHeight, setViewportHeight] = useState(scrollElement.clientHeight)
	const [pointerY, setPointerY] = useState<number | null>(null)
	const [dragging, setDragging] = useState(false)
	const [scrolling, setScrolling] = useState(false)

	useEffect(() => {
		let frame = 0
		let linger = 0

		const onScroll = (): void => {
			setScrolling(true)
			window.clearTimeout(linger)
			linger = window.setTimeout(() => {
				setScrolling(false)
			}, SCROLL_PILL_LINGER_MS)

			if (frame !== 0) {
				return
			}

			frame = requestAnimationFrame(() => {
				frame = 0
				setScrollTop(scrollElement.scrollTop)
			})
		}

		const observer = new ResizeObserver(() => {
			setViewportHeight(scrollElement.clientHeight)
			setRailHeight(railRef.current?.clientHeight ?? 0)
		})

		scrollElement.addEventListener("scroll", onScroll, { passive: true })
		observer.observe(scrollElement)

		return () => {
			scrollElement.removeEventListener("scroll", onScroll)
			observer.disconnect()
			window.clearTimeout(linger)

			if (frame !== 0) {
				cancelAnimationFrame(frame)
			}
		}
	}, [scrollElement])

	const maxScroll = Math.max(0, timeline.totalSize - viewportHeight)
	const trackLength = railHeight - TRACK_INSET_PX * 2

	if (maxScroll <= 0 || trackLength <= 0) {
		return (
			<div
				ref={railRef}
				aria-hidden="true"
				className="w-14 shrink-0"
			/>
		)
	}

	const railY = (offset: number): number => TRACK_INSET_PX + (Math.min(Math.max(offset, 0), maxScroll) / maxScroll) * trackLength
	const offsetAtY = (y: number): number => (Math.min(Math.max(y - TRACK_INSET_PX, 0), trackLength) / trackLength) * maxScroll

	const currentHeader = timelineHeaderAt(timeline, scrollTop)
	const labels: { year: number; y: number }[] = []

	for (const mark of timelineYearMarks(timeline)) {
		const y = railY(mark.offset)
		const previous = labels[labels.length - 1]

		if (previous === undefined || y - previous.y >= LABEL_MIN_GAP_PX) {
			labels.push({ year: mark.year, y })
		}
	}

	// Hovering previews where a press would jump; otherwise the pill rides the handle.
	const handleY = railY(scrollTop)
	const pillY = pointerY !== null && !dragging ? Math.min(Math.max(pointerY, TRACK_INSET_PX), railHeight - TRACK_INSET_PX) : handleY
	const pillHeader = pointerY !== null && !dragging ? timelineHeaderAt(timeline, offsetAtY(pointerY)) : currentHeader
	const pillVisible = pillHeader !== null && (dragging || scrolling || pointerY !== null)

	function yWithin(event: PointerEvent<HTMLDivElement>): number {
		return event.clientY - event.currentTarget.getBoundingClientRect().top
	}

	function jumpTo(y: number): void {
		scrollElement.scrollTo({ top: offsetAtY(y) })
	}

	return (
		<div
			ref={railRef}
			aria-hidden="true"
			{...KEEP_SELECTION_PROPS}
			className="group relative w-14 shrink-0 cursor-pointer touch-none select-none"
			onPointerDown={event => {
				if (event.pointerType === "touch" || event.button !== 0) {
					return
				}

				event.preventDefault()
				event.currentTarget.setPointerCapture(event.pointerId)
				setDragging(true)
				setPointerY(yWithin(event))
				jumpTo(yWithin(event))
			}}
			onPointerMove={event => {
				if (event.pointerType === "touch") {
					return
				}

				setPointerY(yWithin(event))

				if (dragging) {
					jumpTo(yWithin(event))
				}
			}}
			onPointerUp={() => {
				setDragging(false)
			}}
			onPointerCancel={() => {
				setDragging(false)
				setPointerY(null)
			}}
			onPointerLeave={() => {
				if (!dragging) {
					setPointerY(null)
				}
			}}
		>
			<div
				className="absolute right-[11px] w-px bg-border transition-colors group-hover:bg-muted-foreground/40"
				style={{ top: TRACK_INSET_PX, bottom: TRACK_INSET_PX }}
			/>
			{labels.map(label => {
				const current = label.year === currentHeader?.year

				return (
					<div
						key={label.year}
						className="absolute right-[11px] flex -translate-y-1/2 items-center gap-1"
						style={{ top: label.y }}
					>
						<span
							className={cn(
								"text-[11px] tabular-nums",
								current ? "font-semibold text-foreground" : "font-medium text-muted-foreground"
							)}
						>
							{label.year}
						</span>
						<span className={cn("h-px w-1.5", current ? "bg-foreground" : "bg-muted-foreground/50")} />
					</div>
				)
			})}
			<div
				className={cn(
					"absolute right-[9px] w-[5px] -translate-y-1/2 rounded-full shadow-sm transition-[height,background-color] duration-150",
					dragging ? "h-8 bg-foreground" : "h-5 bg-foreground/55 group-hover:bg-foreground/80"
				)}
				style={{ top: handleY }}
			/>
			{pillHeader !== null ? (
				<div
					className={cn(
						"pointer-events-none absolute right-5 z-20 flex -translate-y-1/2 items-baseline gap-1 rounded-full bg-popover py-1 pr-2.5 pl-3 text-xs whitespace-nowrap text-popover-foreground shadow-md ring-1 ring-foreground/10 transition-opacity duration-200",
						pillVisible ? "opacity-100" : "opacity-0"
					)}
					style={{ top: pillY }}
				>
					<span className="font-semibold">{formatTimelineMonthName(i18n.language, pillHeader.month)}</span>
					<span className="text-muted-foreground tabular-nums">{pillHeader.year}</span>
				</div>
			) : null}
		</div>
	)
}
