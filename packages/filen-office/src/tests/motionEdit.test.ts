import { describe, expect, it } from "vitest"
import { parseMotionPath, pointAt } from "../core/anim/motion"
import {
	curvePath,
	deletePoint,
	insertPoint,
	kindOf,
	linePath,
	movePoint,
	moveHandle,
	nearestPoint,
	nearestSegment,
	polyline,
	polylinePath,
	readEditablePath,
	reversePath,
	segmentCount,
	setClosed,
	setPointKind,
	setSegmentType,
	simplifyStroke,
	svgMotionPath,
	translatePath,
	translatePathText,
	writeEditablePath,
	type EditablePath
} from "../core/anim/motionEdit"
import type { Refused } from "../core/presentation/model"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { cpuMs } from "./timing"

// The editable motion path (ECMA-376 §19.5.4): reading and writing the path attribute and ptsTypes, the drawing
// tools' paths, and Edit Points (move, handles, add, delete, segment and point types, open/close, reverse).

function ok(path: EditablePath | Refused): EditablePath {
	if ("reason" in path) throw new Error(`refused: ${path.reason} ${path.detail ?? ""}`)

	return path
}

function points(path: EditablePath): number[][] {
	return Array.from(path.xs, (x, i) => [Math.round(x * 1e5) / 1e5, Math.round((path.ys[i] ?? 0) * 1e5) / 1e5])
}

// Where the player puts the shape at `progress` along `path` (fractions of the slide).
function at(path: string, progress: number): [number, number] {
	const out = pointAt(parseMotionPath(path, 16 / 9, 10_000), progress, new Float64Array(2))

	return [out[0] ?? 0, out[1] ?? 0]
}

describe("motion path attribute", () => {
	it("reads absolute and relative lines and curves into anchors and segments", () => {
		const path = ok(readEditablePath("M 0 0 L 0.25 0 c 0 0.1 0.1 0.1 0.1 0 E"))

		expect(points(path)).toEqual([
			[0, 0],
			[0.25, 0],
			[0.35, 0]
		])
		expect(Array.from(path.curves)).toEqual([0, 1])
		expect(Array.from(path.controls.subarray(4, 8)).map(v => Math.round(v * 1e5) / 1e5)).toEqual([0.25, 0.1, 0.35, 0.1])
	})

	it("reads an explicit return before Z as the closing segment, and a bare Z as a closing line", () => {
		const explicit = ok(readEditablePath("M 0 0 L 0.1 0 L 0.1 0.1 L 0 0 Z"))
		const bare = ok(readEditablePath("M 0 0 L 0.1 0 L 0.1 0.1 Z"))

		for (const path of [explicit, bare]) {
			expect(path.closed).toBe(true)
			expect(path.xs).toHaveLength(3)
			expect(segmentCount(path)).toBe(3)
		}
	})

	it("refuses a path of two subpaths and an unknown command, so it stays as written", () => {
		expect(readEditablePath("M 0 0 L 1 0 M 0 1 L 1 1")).toMatchObject({ kind: "refused", reason: "unsupported" })
		expect(readEditablePath("M 0 0 Q 1 1 2 2")).toMatchObject({ kind: "refused", reason: "unsupported" })
		expect(readEditablePath("L 1 1")).toMatchObject({ kind: "refused", reason: "malformed" })
	})

	it("refuses, before reading it all, a path with more segments than an edit may write", () => {
		const cap = DEFAULT_PRESENTATION_BUDGETS.timing.motionSegments
		const lines = (count: number): string =>
			["M 0 0", ...Array.from({ length: count }, (_, k) => `L ${String((k % 100) / 1000)} ${String((k % 37) / 1000)}`), "E"].join(" ")
		const curves = (count: number): string => ["M 0 0", ...Array.from({ length: count }, () => "c 0 0.1 0.1 0.1 0.1 0"), "E"].join(" ")
		const huge = lines(200_000)
		const start = cpuMs()
		const read = readEditablePath(huge)

		expect(cpuMs() - start).toBeLessThan(20)
		expect(read).toMatchObject({ kind: "refused", reason: "tooLarge" })
		// The bound is the one the motionPath op checks: what reads also applies, and the next segment refuses.
		expect("reason" in readEditablePath(lines(cap))).toBe(false)
		expect(readEditablePath(lines(cap + 1))).toMatchObject({ reason: "tooLarge" })
		expect("reason" in readEditablePath(curves(Math.floor(cap / 16)))).toBe(false)
		expect(readEditablePath(curves(Math.floor(cap / 16) + 1))).toMatchObject({ reason: "tooLarge" })
		expect(readEditablePath(`${lines(cap).slice(0, -2)} Z E`)).toMatchObject({ reason: "tooLarge" })

		const player = (path: string): boolean => {
			try {
				parseMotionPath(path, 1, cap)

				return true
			} catch {
				return false
			}
		}

		expect([lines(cap), lines(cap + 1), curves(Math.floor(cap / 16)), curves(Math.floor(cap / 16) + 1)].map(player)).toEqual([
			true,
			false,
			true,
			false
		])
	})

	it("writes absolute commands at five decimals with E, and ptsTypes with one letter per written point", () => {
		const path = ok(readEditablePath("M 0 0 L 0.123456 -0.0000001 C 0.2 0 0.3 0.1 0.3 0.2 Z E", "AFsA"))
		const written = writeEditablePath(path)

		expect(written.path).toBe("M 0 0 L 0.12346 0 C 0.2 0 0.3 0.1 0.3 0.2 L 0 0 Z E")
		expect(written.ptsTypes).toBe("AfSA")
		expect(kindOf(ok(readEditablePath(written.path, written.ptsTypes)), 2)).toBe("smooth")
	})

	it("round-trips every point type and the case of the segment after each point", () => {
		const path = setPointKind(
			setPointKind(
				ok(
					curvePath([
						{ x: 0, y: 0 },
						{ x: 0.1, y: 0.2 },
						{ x: 0.3, y: 0 }
					])
				),
				1,
				"smooth"
			),
			2,
			"corner"
		)
		const written = writeEditablePath(path)
		const again = ok(readEditablePath(written.path, written.ptsTypes))

		expect(written.ptsTypes).toBe("asF")
		expect(writeEditablePath(again)).toEqual(written)
	})

	it("reads a ptsTypes shorter than the path's points as corners past its end, and ignores extra letters (MS-OI29500)", () => {
		const path = "M 0 0 L 0.1 0 c 0 0.1 0.1 0.1 0.1 0 E"
		const kinds = (types: string): string[] => {
			const read = ok(readEditablePath(path, types))

			return Array.from(read.xs, (_, index) => kindOf(read, index))
		}

		expect(kinds("S")).toEqual(["smooth", "corner", "corner"])
		expect(kinds("STAAAAA")).toEqual(["smooth", "straight", "auto"])
	})

	it("without ptsTypes keeps a curve's handles where the file put them (corner points)", () => {
		const path = ok(readEditablePath("M 0 0 C 0 0.1 0.1 0.1 0.1 0 L 0.2 0"))

		expect([0, 1, 2].map(i => kindOf(path, i))).toEqual(["corner", "corner", "auto"])

		const moved = movePoint(path, 2, 0.3, 0)

		expect(Array.from(moved.controls.subarray(0, 4))).toEqual(Array.from(path.controls.subarray(0, 4)))
	})

	it("drops E for ODF's SVG path data", () => {
		expect(svgMotionPath("M 0 0 L 0.25 0 E")).toBe("M 0 0 L 0.25 0")
		expect(svgMotionPath("M 0 0 L 0.25 0 Z")).toBe("M 0 0 L 0.25 0 Z")
	})
})

describe("drawing tools", () => {
	it("Line writes two auto points and one straight segment the player follows", () => {
		const written = writeEditablePath(linePath({ x: 0, y: 0 }, { x: 0.3, y: -0.1 }))

		expect(written).toEqual({ path: "M 0 0 L 0.3 -0.1 E", ptsTypes: "AA" })
		expect(at(written.path, 0.5)).toEqual([0.15, -0.05])
	})

	it("Curve passes through every clicked point with auto handles", () => {
		const clicks = [
			{ x: 0, y: 0 },
			{ x: 0.1, y: 0.2 },
			{ x: 0.3, y: 0.1 },
			{ x: 0.4, y: 0.3 }
		]
		const path = ok(curvePath(clicks))
		const written = writeEditablePath(path)
		const flat = polyline(path)

		expect(written.ptsTypes).toBe("aaaA")
		expect(written.path.startsWith("M 0 0 C ")).toBe(true)
		// Every anchor is on the drawn curve.
		for (const [index, click] of clicks.entries()) {
			expect(flat[index * 16 * 2]).toBeCloseTo(click.x, 9)
			expect(flat[index * 16 * 2 + 1]).toBeCloseTo(click.y, 9)
		}
	})

	it("Freeform closes on its start with straight segments", () => {
		const path = ok(
			polylinePath(
				[
					{ x: 0, y: 0 },
					{ x: 0.2, y: 0 },
					{ x: 0.2, y: 0.2 }
				],
				true
			)
		)

		expect(writeEditablePath(path)).toEqual({ path: "M 0 0 L 0.2 0 L 0.2 0.2 L 0 0 Z E", ptsTypes: "AAAA" })
	})

	it("Scribble simplifies a stroke to the points that matter, within the tolerance", () => {
		const stroke = new Float64Array(2 * 2001)

		for (let i = 0; i <= 2000; i++) {
			stroke[i * 2] = i / 4000
			// A straight run, then a corner.
			stroke[i * 2 + 1] = i < 1000 ? 0 : (i - 1000) / 4000
		}

		const kept = simplifyStroke(stroke, 0.0005, 1)

		expect(kept).toEqual([
			{ x: 0, y: 0 },
			{ x: 0.25, y: 0 },
			{ x: 0.5, y: 0.25 }
		])
	})
})

describe("Edit Points", () => {
	const square = (): EditablePath =>
		ok(
			polylinePath(
				[
					{ x: 0, y: 0 },
					{ x: 0.2, y: 0 },
					{ x: 0.2, y: 0.2 },
					{ x: 0, y: 0.2 }
				],
				true
			)
		)

	it("moves a point with its handles; a line's thirds follow", () => {
		const moved = movePoint(square(), 2, 0.3, 0.3)

		expect(points(moved)[2]).toEqual([0.3, 0.3])
		expect(writeEditablePath(moved).path).toBe("M 0 0 L 0.2 0 L 0.3 0.3 L 0 0.2 L 0 0 Z E")
	})

	it("an auto point's neighbour curves re-smooth when it moves", () => {
		const path = ok(
			curvePath([
				{ x: 0, y: 0 },
				{ x: 0.1, y: 0.1 },
				{ x: 0.2, y: 0 }
			])
		)
		const moved = movePoint(path, 1, 0.1, 0.3)

		expect(moved.controls[3]).not.toBe(path.controls[3])
		expect(writeEditablePath(moved)).toEqual(
			writeEditablePath(
				ok(
					curvePath([
						{ x: 0, y: 0 },
						{ x: 0.1, y: 0.3 },
						{ x: 0.2, y: 0 }
					])
				)
			)
		)
	})

	// PowerPoint, "Draw or edit a freeform shape": "A smooth point joins two line segments of equal length. A straight
	// point joins two line segments of different lengths." (ECMA-376 §19.5.4 ptsTypes only names T Straight, S Smooth.)
	it("dragging a straight point's handle turns the other one in line, keeping its length; a smooth point's matches it", () => {
		const path = setPointKind(
			ok(
				curvePath([
					{ x: 0, y: 0 },
					{ x: 0.1, y: 0.1 },
					{ x: 0.2, y: 0 }
				])
			),
			1,
			"straight"
		)
		const straight = moveHandle(path, 0, 1, 0.1, 0.05)
		const before = Math.hypot((path.controls[4] ?? 0) - 0.1, (path.controls[5] ?? 0) - 0.1)

		expect(Math.hypot((straight.controls[4] ?? 0) - 0.1, (straight.controls[5] ?? 0) - 0.1)).toBeCloseTo(before, 12)
		expect(straight.controls[4]).toBeCloseTo(0.1, 12)
		expect(straight.controls[5]).toBeCloseTo(0.1 + before, 12)

		const smooth = moveHandle(setPointKind(path, 1, "smooth"), 0, 1, 0.1, 0.05)

		expect(smooth.controls[5]).toBeCloseTo(0.15, 12)
	})

	it("a smooth point's handles are made one length, a straight point's keep theirs", () => {
		// A corner whose incoming handle is drawn out to twice its length, in line with the other.
		const corner = setPointKind(
			ok(
				curvePath([
					{ x: 0, y: 0 },
					{ x: 0.1, y: 0.1 },
					{ x: 0.4, y: 0 }
				])
			),
			1,
			"corner"
		)
		const path = moveHandle(corner, 0, 1, 0.1 + 2 * ((corner.controls[2] ?? 0) - 0.1), 0.1 + 2 * ((corner.controls[3] ?? 0) - 0.1))
		const lengths = (p: EditablePath): number[] => [
			Math.hypot((p.controls[2] ?? 0) - 0.1, (p.controls[3] ?? 0) - 0.1),
			Math.hypot((p.controls[4] ?? 0) - 0.1, (p.controls[5] ?? 0) - 0.1)
		]
		const [inner = 0, outer = 0] = lengths(path)
		const smooth = lengths(setPointKind(path, 1, "smooth"))
		const straight = lengths(setPointKind(path, 1, "straight"))

		expect(inner).not.toBeCloseTo(outer, 6)
		expect(smooth[0]).toBeCloseTo(smooth[1] ?? 0, 12)
		expect(straight[0]).toBeCloseTo(inner, 12)
		expect(straight[1]).toBeCloseTo(outer, 12)
	})

	it("an auto point whose handle is dragged becomes smooth; a corner's handles move alone", () => {
		const path = ok(
			curvePath([
				{ x: 0, y: 0 },
				{ x: 0.1, y: 0.1 },
				{ x: 0.2, y: 0 }
			])
		)

		expect(kindOf(moveHandle(path, 0, 1, 0.05, 0.1), 1)).toBe("smooth")

		const corner = setPointKind(path, 1, "corner")
		const moved = moveHandle(corner, 0, 1, 0.05, 0.1)

		expect(Array.from(moved.controls.subarray(4))).toEqual(Array.from(corner.controls.subarray(4)))
	})

	it("adds a point on a curve without changing its shape, and on a line at its middle", () => {
		const path = ok(
			curvePath([
				{ x: 0, y: 0 },
				{ x: 0.1, y: 0.2 },
				{ x: 0.3, y: 0 }
			])
		)
		const added = insertPoint(path, 0, 0.5)
		const a = polyline(path, 64)
		const b = polyline(added, 32)

		expect(added.xs).toHaveLength(4)
		expect(kindOf(added, 1)).toBe("straight")
		expect(b[32 * 2]).toBeCloseTo(a[32 * 2] ?? 0, 12)
		expect(b[32 * 2 + 1]).toBeCloseTo(a[32 * 2 + 1] ?? 0, 12)

		expect(points(insertPoint(square(), 3))[4]).toEqual([0, 0.1])
	})

	it("deletes a point, merging its segments; keeps two points (three closed)", () => {
		const removed = deletePoint(square(), 2)

		expect(writeEditablePath(removed).path).toBe("M 0 0 L 0.2 0 L 0 0.2 L 0 0 Z E")
		expect(writeEditablePath(deletePoint(square(), 0)).path).toBe("M 0.2 0 L 0.2 0.2 L 0 0.2 L 0.2 0 Z E")
		expect(deletePoint(deletePoint(square(), 0), 0).xs).toHaveLength(3)
		expect(deletePoint(linePath({ x: 0, y: 0 }, { x: 1, y: 0 }), 0).xs).toHaveLength(2)
	})

	it("switches a segment between straight and curved", () => {
		const curved = setSegmentType(square(), 1, "curve")

		expect(writeEditablePath(curved).ptsTypes).toBe("AaAAA")
		expect(writeEditablePath(setSegmentType(curved, 1, "line"))).toEqual(writeEditablePath(square()))
	})

	it("opens and closes a path", () => {
		const open = setClosed(square(), false)

		expect(writeEditablePath(open)).toEqual({ path: "M 0 0 L 0.2 0 L 0.2 0.2 L 0 0.2 E", ptsTypes: "AAAA" })
		expect(writeEditablePath(setClosed(open, true))).toEqual(writeEditablePath(square()))
	})

	it("reverses a path: the player travels it from the other end", () => {
		const path = ok(
			curvePath([
				{ x: 0, y: 0 },
				{ x: 0.1, y: 0.2 },
				{ x: 0.3, y: 0 },
				{ x: 0.4, y: 0.1 }
			])
		)
		const forward = writeEditablePath(path).path
		const backward = writeEditablePath(reversePath(path)).path

		for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
			const [ax, ay] = at(forward, progress)
			const [bx, by] = at(backward, 1 - progress)

			expect(bx).toBeCloseTo(ax, 4)
			expect(by).toBeCloseTo(ay, 4)
		}

		expect(writeEditablePath(reversePath(reversePath(path)))).toEqual(writeEditablePath(path))
		expect(writeEditablePath(reversePath(square())).path).toBe("M 0 0 L 0 0.2 L 0.2 0.2 L 0.2 0 L 0 0 Z E")
	})

	it("moves a whole path, for a locked path whose shape moved", () => {
		expect(writeEditablePath(translatePath(square(), 0.1, -0.1)).path).toBe("M 0.1 -0.1 L 0.3 -0.1 L 0.3 0.1 L 0.1 0.1 L 0.1 -0.1 Z E")
	})

	it("moves a path as text: absolute pairs shift, relative ones and the commands stay", () => {
		expect(translatePathText("M 0 0 L 0.25 0 c 0.1 0 0.1 0.1 0.2 0.1 E", 0.1, -0.2)).toBe(
			"M 0.1 -0.2 L 0.35 -0.2 c 0.1 0 0.1 0.1 0.2 0.1 E"
		)
		expect(translatePathText("m 0 0 l 0.1 0 z", 0.5, 0.5)).toBe("m 0.5 0.5 l 0.1 0 z")
	})

	it("finds the point and the segment under the pointer", () => {
		expect(nearestPoint(square(), 0.201, 0.199, 0.01, 1)).toBe(2)
		expect(nearestPoint(square(), 0.1, 0.1, 0.01, 1)).toBe(-1)
		expect(nearestSegment(square(), 0.1, 0.201, 0.01, 1)).toMatchObject({ segment: 2 })
	})
})
