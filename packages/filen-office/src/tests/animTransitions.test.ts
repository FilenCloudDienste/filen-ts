import { describe, expect, it } from "vitest"
import {
	inRegion,
	RANDOM_TRANSITION_KINDS,
	randomTransitionKind,
	transitionFrame,
	transitionToOdf,
	type TransitionFrame
} from "../core/anim/transitions"
import { playableTransition } from "../core/anim/presets/transitions/catalog"
import { stageDraws } from "../dom/presentation/engine/show"

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

	it("flashes through white over each half, and fades ODF fadeOverColor through its smil:fadeColor", () => {
		expect(transitionFrame("fade", { thruBlk: true }, 0.25).overlay).toBe("#000000")
		expect(transitionFrame("fade", {}, 0.5)).toMatchObject({ black: 0 })
		expect(transitionFrame("flash", {}, 0.25)).toMatchObject({ incoming: { opacity: 0 }, black: 0.5, overlay: "#ffffff" })
		expect(transitionFrame("flash", {}, 0.75)).toMatchObject({ incoming: { opacity: 0.5 }, black: 1, overlay: "#ffffff" })
		expect(transitionFrame("flash", {}, 1).incoming.opacity).toBe(1)
		expect(transitionFrame("fade", { thruBlk: true, smilFadeColor: "#ff0000" }, 0.25).overlay).toBe("#ff0000")
		expect(transitionFrame("fade", { thruBlk: true, smilFadeColor: "red;x" }, 0.25).overlay).toBe("#000000")
	})

	it("picks p:random's kind from the drawn ECMA kinds, never cut or random", () => {
		expect(RANDOM_TRANSITION_KINDS).not.toContain("cut")
		expect(RANDOM_TRANSITION_KINDS).not.toContain("random")

		const seen = new Set<string>()

		for (let k = 0; k < RANDOM_TRANSITION_KINDS.length; k++) seen.add(randomTransitionKind((k + 0.5) / RANDOM_TRANSITION_KINDS.length))

		expect(seen.size).toBe(RANDOM_TRANSITION_KINDS.length)
		expect(randomTransitionKind(0)).toBe(RANDOM_TRANSITION_KINDS[0])
		expect(randomTransitionKind(1)).toBe(RANDOM_TRANSITION_KINDS[RANDOM_TRANSITION_KINDS.length - 1])
		expect(transitionFrame(randomTransitionKind(0.99), {}, 0.5)).not.toEqual(transitionFrame("fade", {}, 0.5))
	})

	it("plays p14:flash itself on the stage, not its plain-fade Fallback", () => {
		const flash = { kind: "flash", namespace: "p14" as const, options: {}, advance: { onClick: true } }
		const fileFallback = { ...flash, kind: "fade", namespace: "p" as const }

		expect(playableTransition(flash, stageDraws, fileFallback)).toBe(flash)
		expect(playableTransition({ ...flash, kind: "vortex" }, stageDraws, fileFallback)).toBe(fileFallback)
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
