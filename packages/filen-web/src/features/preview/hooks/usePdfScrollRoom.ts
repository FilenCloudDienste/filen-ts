import { useEffect, useState, type RefObject } from "react"
import { PDF_SCROLL_ROOM_ANY, pdfScrollRoom, sameScrollRoom, type PdfScrollRoom } from "@/features/preview/lib/pdfScrollRoom.logic"

// The page column's room to scroll either way (pdfScrollRoom.logic.ts), followed as it scrolls and as it or its pages
// resize: read at most once a frame, three layout reads and no writes, and a render only when an end is reached or
// left.
export function usePdfScrollRoom(scrollerRef: RefObject<HTMLElement | null>): PdfScrollRoom {
	const [room, setRoom] = useState<PdfScrollRoom>(PDF_SCROLL_ROOM_ANY)

	useEffect(() => {
		const scroller = scrollerRef.current

		if (scroller === null) {
			return
		}

		let frame = 0
		const measure = (): void => {
			frame = 0

			const next = pdfScrollRoom(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight)

			setRoom(previous => (sameScrollRoom(previous, next) ? previous : next))
		}
		const schedule = (): void => {
			if (frame === 0) {
				frame = requestAnimationFrame(measure)
			}
		}
		// The scroller's own size, and its column's: pages sizing, a zoom or a reflow change how far it scrolls.
		const observer = new ResizeObserver(schedule)

		observer.observe(scroller)

		for (const child of scroller.children) {
			observer.observe(child)
		}

		scroller.addEventListener("scroll", schedule, { passive: true })
		schedule()

		return () => {
			scroller.removeEventListener("scroll", schedule)
			observer.disconnect()
			cancelAnimationFrame(frame)
		}
	}, [scrollerRef])

	return room
}
