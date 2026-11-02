// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import type { Transition } from "../core/anim/model"
import { TRANSITION_PRESETS } from "../core/anim/presets/transitions/catalog"
import { draws3d, newFrame, transitionGeometry, transitions3d } from "../react/presentation/show/transitions3d"
import { budget, cpuMs } from "./timing"

// The per-frame work of the 3D transitions, in main-thread CPU: one second at 60 frames of every kind's geometry,
// and a fracture's 49 pieces written as CSS each frame (the most pieces of any kind). A frame's share must stay far
// below the 16 ms frame budget.

const SLIDE = { w: 1280, h: 720 }
const FRAMES = 60
const RUNS = 3
// All 25 kinds × 60 frames.
const GEOMETRY_LIMIT_MS = 40
// One fracture second: its start and 60 frames of 49 pieces (happy-dom's style setters dominate: a browser spends a
// fraction of it).
const CSS_LIMIT_MS = 150

function transition(kind: string, namespace: Transition["namespace"]): Transition {
	return { kind, namespace, options: {}, durationMs: 1000, advance: { onClick: true } }
}

function least(work: () => void): number {
	let best = Number.POSITIVE_INFINITY

	for (let run = 0; run < RUNS; run++) {
		const start = cpuMs()

		work()
		best = Math.min(best, cpuMs() - start)
	}

	return best
}

describe("3D transition frames", () => {
	it(`computes a second of frames of every 3D kind in ≤ ${String(GEOMETRY_LIMIT_MS)} ms CPU`, { timeout: budget(60_000) }, () => {
		const geometries = TRANSITION_PRESETS.filter(preset => draws3d(preset.kind, preset.namespace)).flatMap(preset => {
			const geometry = transitionGeometry(transition(preset.kind, preset.namespace), SLIDE)

			return geometry === undefined ? [] : [{ geometry, frame: newFrame(geometry) }]
		})

		expect(geometries).toHaveLength(25)
		const spent = least(() => {
			for (const { geometry, frame } of geometries) for (let k = 0; k <= FRAMES; k++) geometry.frame(k / FRAMES, frame)
		})

		expect(spent).toBeLessThan(GEOMETRY_LIMIT_MS)
	})

	it(`writes a second of a fracture's frames in ≤ ${String(CSS_LIMIT_MS)} ms CPU`, { timeout: budget(60_000) }, () => {
		Reflect.set(globalThis, "CSS", { supports: () => true })
		// happy-dom has no canvas: a 2D context that draws nothing (the frames' cost is the CSS written).
		const nothing = (): void => undefined
		const context = {
			setTransform: nothing,
			fillRect: nothing,
			drawImage: nothing,
			save: nothing,
			restore: nothing,
			globalAlpha: 1,
			fillStyle: ""
		}

		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D)

		const host = document.createElement("div")
		const box = (): HTMLDivElement => {
			const element = document.createElement("div")

			element.style.cssText = "position:absolute;left:0;top:0;width:1280px;height:720px;background:#fff"
			host.appendChild(element)

			return element
		}
		const outgoing = box()
		const incoming = box()

		document.body.appendChild(host)

		try {
			const spent = least(() => {
				const run = transitions3d.start({
					document,
					host,
					outgoing,
					incoming,
					transition: transition("fracture", "p15"),
					slide: SLIDE,
					pixelRatio: 1,
					budgetBytes: 256 * 1024 * 1024
				})

				if (run === undefined) throw new Error("refused")

				for (let k = 1; k < FRAMES; k++) run.frame(k / FRAMES)

				run.finish()
			})

			expect(spent).toBeLessThan(CSS_LIMIT_MS)
		} finally {
			Reflect.deleteProperty(globalThis, "CSS")
			vi.restoreAllMocks()
			host.remove()
		}
	})
})
