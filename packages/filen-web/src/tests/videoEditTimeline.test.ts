import { describe, expect, it } from "vitest"
import {
	filmstripSlots,
	formatTimecode,
	fullView,
	isZoomed,
	MIN_VIEW_SPAN,
	panView,
	parseTimecode,
	pinchFactor,
	revealTime,
	rulerTicks,
	sliderKeyTarget,
	snapMarks,
	timeToX,
	wheelZoomFactor,
	xToTime,
	zoomView
} from "@/features/preview/videoEdit/lib/timeline.logic"

describe("timeline view", () => {
	it("zooms about an anchor that stays put", () => {
		const view = zoomView(fullView(100), 2, 25, 100)

		expect(view.end - view.start).toBe(50)
		// 25 s sat a quarter of the way along; it still does.
		expect((25 - view.start) / (view.end - view.start)).toBeCloseTo(0.25)
		expect(isZoomed(view, 100)).toBe(true)
	})

	it("never zooms past the whole source or below the minimum span", () => {
		expect(zoomView(fullView(100), 0.1, 50, 100)).toEqual({ start: 0, end: 100 })

		const tight = zoomView(fullView(100), 10_000, 50, 100)

		expect(tight.end - tight.start).toBeCloseTo(MIN_VIEW_SPAN)
	})

	it("pans inside the source and reveals a time", () => {
		const view = { start: 10, end: 20 }

		expect(panView(view, -50, 100)).toEqual({ start: 0, end: 10 })
		expect(panView(view, 500, 100)).toEqual({ start: 90, end: 100 })
		expect(revealTime(view, 15, 100)).toBe(view)
		expect(revealTime(view, 30, 100)).toEqual({ start: 21, end: 31 })
	})

	it("maps time to x and back", () => {
		const view = { start: 10, end: 20 }

		expect(timeToX(view, 500, 15)).toBe(250)
		expect(xToTime(view, 500, 250)).toBe(15)
	})
})

describe("timecodes", () => {
	it("formats minutes, seconds and hundredths, hours from an hour on", () => {
		expect(formatTimecode(12.4)).toBe("00:12.40")
		expect(formatTimecode(105)).toBe("01:45.00")
		expect(formatTimecode(3723.5)).toBe("1:02:03.50")
		expect(formatTimecode(-1)).toBe("00:00.00")
	})

	it("parses what a user types", () => {
		expect(parseTimecode("12")).toBe(12)
		expect(parseTimecode("12,5")).toBe(12.5)
		expect(parseTimecode("01:45.00")).toBe(105)
		expect(parseTimecode("1:02:03.5")).toBe(3723.5)
		expect(parseTimecode("1:75")).toBeNull()
		expect(parseTimecode("abc")).toBeNull()
		expect(parseTimecode("")).toBeNull()
	})
})

describe("keys on a trim handle", () => {
	const bounds = { start: 0, end: 100 }

	it("steps a frame, a second, ten seconds, or to the bounds", () => {
		expect(sliderKeyTarget("ArrowRight", false, 10, bounds, 25)).toBeCloseTo(10.04)
		expect(sliderKeyTarget("ArrowLeft", true, 10, bounds, 25)).toBe(9)
		expect(sliderKeyTarget("PageUp", false, 10, bounds, 25)).toBe(20)
		expect(sliderKeyTarget("PageDown", false, 5, bounds, 25)).toBe(0)
		expect(sliderKeyTarget("End", false, 5, bounds, 25)).toBe(100)
		expect(sliderKeyTarget("Home", false, 5, bounds, 25)).toBe(0)
		expect(sliderKeyTarget("a", false, 5, bounds, 25)).toBeNull()
	})
})

describe("filmstrip and ruler", () => {
	it("puts tiles on a grid fixed in source time", () => {
		const a = filmstripSlots({ start: 0, end: 10 }, 1000, 100, 60)
		const b = filmstripSlots({ start: 1, end: 11 }, 1000, 100, 60)

		expect(a.step).toBe(b.step)
		expect(a.times.length).toBeGreaterThan(0)
		// The tiles both views show are the same times.
		expect(b.times.filter(time => a.times.includes(time)).length).toBeGreaterThan(0)
		expect(filmstripSlots({ start: 0, end: 10 }, 0, 100, 60).times).toEqual([])
	})

	it("labels the ruler at a readable step", () => {
		const ticks = rulerTicks({ start: 0, end: 60 }, 600, 50)

		expect(ticks[0]).toBe(0)
		expect(ticks[1]).toBe(5)
	})
})

describe("snapping", () => {
	it("marks edges moved by a frame or more, with a chip from a second", () => {
		const marks = snapMarks(
			[
				{ requested: 10, actual: 12.1 },
				{ requested: 5, actual: 5.01 },
				{ requested: 2, actual: 1.5 }
			],
			25
		)

		expect(marks.map(mark => [mark.requested, mark.chip])).toEqual([
			[2, false],
			[10, true]
		])
		expect(marks[0]?.delta).toBe(-0.5)
		expect(marks[1]?.delta).toBeCloseTo(2.1)
	})
})

describe("gestures", () => {
	it("turns pinches and wheels into zoom factors", () => {
		expect(pinchFactor(100, 200)).toBe(2)
		expect(pinchFactor(0, 200)).toBe(1)
		expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1)
		expect(wheelZoomFactor(100, 0)).toBeLessThan(1)
	})
})
