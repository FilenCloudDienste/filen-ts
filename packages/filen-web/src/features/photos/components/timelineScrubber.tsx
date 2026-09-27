import { useEffect, useRef, useState, type PointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { KEEP_SELECTION_PROPS } from "@/features/drive/lib/clickAway.logic"
import { formatTimelineMonth, timelineHeaderAt, timelineYearMarks, type PhotosTimeline } from "@/features/photos/lib/timeline"

// Vertical room one year label needs; a year closer to the previous label than this goes unlabeled.
const LABEL_MIN_GAP_PX = 18

// Stands in for the grid's scrollbar (hidden while this rail is shown): the rail is the whole scroll
// range, years are marked where they begin, and a press or drag jumps there while a bubble names the
// month under the pointer. Mouse and pen only; keyboard users keep the grid's own keys and the scroll
// container's Page Up/Down, and touch keeps native scrolling.
export function TimelineScrubber({ timeline, scrollElement }: { timeline: PhotosTimeline; scrollElement: HTMLDivElement }) {
	const { i18n } = useTranslation()
	const railRef = useRef<HTMLDivElement>(null)
	const [railHeight, setRailHeight] = useState(0)
	const [scrollTop, setScrollTop] = useState(scrollElement.scrollTop)
	const [viewportHeight, setViewportHeight] = useState(scrollElement.clientHeight)
	const [pointerY, setPointerY] = useState<number | null>(null)
	const [dragging, setDragging] = useState(false)

	useEffect(() => {
		let frame = 0

		const onScroll = (): void => {
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

			if (frame !== 0) {
				cancelAnimationFrame(frame)
			}
		}
	}, [scrollElement])

	const maxScroll = Math.max(0, timeline.totalSize - viewportHeight)

	if (maxScroll <= 0 || railHeight <= 0) {
		return (
			<div
				ref={railRef}
				aria-hidden="true"
				className="w-10 shrink-0"
			/>
		)
	}

	const railY = (offset: number): number => (Math.min(Math.max(offset, 0), maxScroll) / maxScroll) * railHeight
	const offsetAtY = (y: number): number => (Math.min(Math.max(y, 0), railHeight) / railHeight) * maxScroll

	const labels: { year: number; y: number }[] = []

	for (const mark of timelineYearMarks(timeline)) {
		const y = railY(mark.offset)
		const previous = labels[labels.length - 1]

		if (previous === undefined || y - previous.y >= LABEL_MIN_GAP_PX) {
			labels.push({ year: mark.year, y })
		}
	}

	const bubbleHeader = pointerY === null ? null : timelineHeaderAt(timeline, offsetAtY(pointerY))

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
			className="relative w-10 shrink-0 cursor-pointer touch-none select-none"
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
			{labels.map(label => (
				<span
					key={label.year}
					className="absolute right-1.5 -translate-y-1/2 text-[10px] font-medium text-muted-foreground tabular-nums"
					style={{ top: Math.min(Math.max(label.y, 6), railHeight - 6) }}
				>
					{label.year}
				</span>
			))}
			<div
				className="absolute right-0 h-6 w-1 -translate-y-1/2 rounded-full bg-foreground/40"
				style={{ top: Math.min(Math.max(railY(scrollTop), 12), railHeight - 12) }}
			/>
			{bubbleHeader !== null && pointerY !== null ? (
				<div
					className="pointer-events-none absolute right-full z-20 mr-2 -translate-y-1/2 rounded-md bg-popover px-2 py-1 text-xs font-medium whitespace-nowrap text-popover-foreground shadow-md ring-1 ring-foreground/10"
					style={{ top: Math.min(Math.max(pointerY, 14), railHeight - 14) }}
				>
					{formatTimelineMonth(i18n.language, bubbleHeader.year, bubbleHeader.month)}
				</div>
			) : null}
		</div>
	)
}
