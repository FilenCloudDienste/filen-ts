import { describe, expect, it } from "vitest"
import { inRegion, transitionFrame, transitionToOdf, type TransitionFrame } from "../core/anim/transitions"

// The ECMA transitions' progress functions at t = 0, 0.5 and 1: the share of the slide the incoming slide shows, or
// the slides' offsets, scale and opacity.

function revealed(frame: TransitionFrame): number {
	let inside = 0
	const cols = 160
	const rows = 120

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) if (inRegion(frame.reveal, (col + 0.5) / cols, (row + 0.5) / rows)) inside++
	}

	return inside / (cols * rows)
}

const REVEALS: readonly (readonly [string, Record<string, string>, number])[] = [
	["wipe", { dir: "l" }, 0.5],
	["wipe", { dir: "d" }, 0.5],
	["blinds", { dir: "vert" }, 0.5],
	["checker", {}, 0.5],
	["comb", { dir: "vert" }, 0.5],
	["split", { orient: "vert", dir: "in" }, 0.5],
	["split", {}, 0.5],
	["randomBar", {}, 0.5],
	["dissolve", {}, 0.5],
	["strips", { dir: "rd" }, 0.5],
	["wedge", {}, 0.5],
	["wheel", { spokes: "4" }, 0.5],
	["circle", {}, Math.PI * (0.5 * Math.SQRT1_2) ** 2],
	["diamond", {}, 0.5],
	["plus", {}, 0.75]
]

describe("transition progress", () => {
	for (const [kind, options, half] of REVEALS) {
		it(`reveals ${kind} ${JSON.stringify(options)} as 0, ${half.toFixed(3)} and 1 of the slide`, () => {
			expect(revealed(transitionFrame(kind, options, 0))).toBeCloseTo(0, 2)
			expect(revealed(transitionFrame(kind, options, 0.5))).toBeCloseTo(half, 1)
			expect(Math.abs(revealed(transitionFrame(kind, options, 0.5)) - half)).toBeLessThan(0.02)
			expect(revealed(transitionFrame(kind, options, 1))).toBeCloseTo(1, 2)
		})
	}

	it("moves the slides of push, cover and pull along the direction", () => {
		expect(transitionFrame("push", { dir: "l" }, 0.5)).toMatchObject({ incoming: { dx: 0.5 }, outgoing: { dx: -0.5 } })
		expect(transitionFrame("push", { dir: "u" }, 0).incoming.dy).toBe(1)
		expect(transitionFrame("cover", { dir: "r" }, 0.5)).toMatchObject({ incoming: { dx: -0.5 }, outgoing: { dx: 0 } })
		expect(transitionFrame("pull", { dir: "d" }, 1)).toMatchObject({ outgoing: { dy: 1 }, outgoingOnTop: true })
	})

	it("fades directly, or through black over each half", () => {
		expect(transitionFrame("fade", {}, 0.5).incoming.opacity).toBe(0.5)
		expect(transitionFrame("fade", { thruBlk: true }, 0.25)).toMatchObject({ incoming: { opacity: 0 }, black: 0.5 })
		expect(transitionFrame("fade", { thruBlk: true }, 0.75)).toMatchObject({ incoming: { opacity: 0.5 }, black: 1 })
		expect(transitionFrame("fade", {}, 1).incoming.opacity).toBe(1)
	})

	it("zooms and spins newsflash in", () => {
		expect(transitionFrame("newsflash", {}, 0)).toMatchObject({ incoming: { scale: 0, rotation: 720 } })
		expect(transitionFrame("newsflash", {}, 0.5)).toMatchObject({ incoming: { scale: 0.5, rotation: 360 } })
		expect(transitionFrame("zoom", {}, 0.5).incoming.scale).toBe(0.5)
	})

	it("maps ECMA transitions to SMIL as the ODP reader maps them back", () => {
		expect(transitionToOdf("wipe", { dir: "l" })).toEqual({ type: "barWipe", subtype: "leftToRight", reverse: true })
		expect(transitionToOdf("push", { dir: "d" })).toEqual({ type: "pushWipe", subtype: "fromTop", reverse: false })
		expect(transitionToOdf("pull", {})).toEqual({ type: "slideWipe", subtype: "fromRight", reverse: true })
		expect(transitionToOdf("fade", { smilType: "fade", smilSubtype: "fadeToColor" })).toEqual({
			type: "fade",
			subtype: "fadeToColor",
			reverse: false
		})
		expect(transitionToOdf("vortex", {})).toBeUndefined()
	})
})
