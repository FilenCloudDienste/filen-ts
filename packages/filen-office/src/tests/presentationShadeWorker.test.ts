import { describe, expect, it } from "vitest"
import { ShadeJob } from "../core/drawingml/shade"
import type { CallContext, EngineSession } from "../dom/presentation/engine"
import { viewCapability } from "../dom/presentation/engine/view"
import { decodePng } from "./oracles/presentation/pixel"

// The worker's side of a shaded raster: the page sends a render's meshes back, the worker rasterises them in slices,
// encodes a PNG and answers a Blob of the size the page planned.

const MESH = { points: Float32Array.of(0, 0, 200, 0, 0, 200), colors: Uint32Array.of(0xff0000ff, 0x00ff00ff, 0x0000ffff), ramp: null }

function context(aborted = false): { context: CallContext; pauses: () => number } {
	let pauses = 0

	return {
		context: {
			session: {} as EngineSession,
			signal: { aborted, onAbort: () => undefined },
			lane: "background",
			slicing: {
				pause: () => {
					pauses++

					return Promise.resolve()
				},
				sliceMs: 0,
				now: () => 0
			}
		},
		pauses: () => pauses
	}
}

describe("shaded rasters in the worker", () => {
	it("answers a PNG of the planned size and extent, made in slices", async () => {
		const { context: call, pauses } = context()
		const answer = await viewCapability.shade(call, [MESH], 2, 1_000_000)
		const plan = ShadeJob.plan([MESH], 2, 1_000_000)

		if (answer === null || plan === undefined) throw new Error("refused")

		const png = decodePng(new Uint8Array(await answer.png.arrayBuffer()))

		expect([png.width, png.height]).toEqual([plan.width, plan.height])
		expect(answer.bounds).toEqual(plan.bounds)
		// Near the red corner red dominates.
		expect(png.data[(2 * png.width + 2) * 4]).toBeGreaterThan(200)
		expect(pauses()).toBeGreaterThan(0)
	})

	it("answers null for a raster the plan refuses, and refuses an aborted call", async () => {
		expect(await viewCapability.shade(context().context, [MESH], 2, 0)).toBeNull()
		await expect(viewCapability.shade(context(true).context, [MESH], 2, 1_000_000)).rejects.toMatchObject({ reason: "aborted" })
	})
})
