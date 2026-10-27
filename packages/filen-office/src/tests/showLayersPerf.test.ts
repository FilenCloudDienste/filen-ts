import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { compileSource, instantiate } from "../core/anim/timegraph"
import type { Canvas2DLike } from "../core/drawingml/canvas"
import { bytesSource } from "../core/opc/index"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import type { CallContext, EngineSession } from "../dom/presentation/engine"
import { openOdpCapability } from "../dom/presentation/engine/open/odp"
import { openPptxCapability } from "../dom/presentation/engine/open/pptx"
import { showCapability } from "../dom/presentation/engine/show"
import { installPresentationRealm, type RasterCanvas, type RasterImage } from "../dom/presentation/services"
import { layerPlanOf } from "../react/presentation/show/layers"
import { CORPUS_DIR } from "./corpusDir"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { cpuMs } from "./timing"

// The show's preparation and frames on the corpus's 20 most animated slides (H0's mostAnimated: govuk Shaping, the
// SmartArt org chart fly-in, York, bbfa, customGeo, CompanyBackground, typical): the worker's timegraph() and layers()
// at a 1920 px stage, as the player asks for the slide after the one on stage, and the page's compile and per-frame
// sample() over the slide's whole timeline. Canvases draw nothing (the browsers' rasterisation is the harness's).
// Budgets: a slide rendered and its timing and layers prepared ≤ 250 ms of worker CPU (while the slide before plays), compile ≤ 5 ms, a frame's
// sample ≤ 2 ms at the 99th percentile.

const SLIDES: readonly (readonly [string, number])[] = [
	["odp/govuk__Shaping_the_Qualifications_Landscape.odp", 71],
	["pptx/govuk__Shaping_the_Qualifications_Landscape.pptx", 71],
	["pptx/oxsdk__SmartArt_OrgChart1_3D_Animation_Fly_In_by_level_one_by_one_.pptx", 1],
	["pptx/govuk__Final_findings__slide_deck__-_York_Administrative_Fairness_Lab.pptx", 2],
	["odp/govuk__bbfa-11-business-lifecycle.odp", 5],
	["odp/govuk__bbfa-11-business-lifecycle.odp", 3],
	["pptx/poi__customGeo.pptx", 15],
	["odp/govuk__bbfa-11-business-lifecycle.odp", 4],
	["odp/govuk__bbfa-11-business-lifecycle.odp", 7],
	["odp/govuk__bbfa-11-business-lifecycle.odp", 8],
	["pptx/poi__customGeo.pptx", 48],
	["odp/govuk__Shaping_the_Qualifications_Landscape.odp", 61],
	["pptx/govuk__Shaping_the_Qualifications_Landscape.pptx", 61],
	["odp/govuk__Shaping_the_Qualifications_Landscape.odp", 23],
	["potx/oxsdk__CompanyBackgroundPresentation_TP10219425.potx", 2],
	["pptx/govuk__Shaping_the_Qualifications_Landscape.pptx", 23],
	["odp/govuk__Shaping_the_Qualifications_Landscape.odp", 63],
	["pptx/govuk__Shaping_the_Qualifications_Landscape.pptx", 63],
	["pptx/poi__customGeo.pptx", 18],
	["pptx/oxsdk__typical.pptx", 3]
]
const STEP_GAP_MS = 4000
const FRAME_MS = 1000 / 60

// A 2D context that draws nothing: every call is a no-op, text measures 8 px a character.
function nullCanvas(width: number, height: number): RasterCanvas {
	const state: Record<string | symbol, unknown> = {}
	const context = new Proxy(state, {
		get(target, name) {
			if (name in target) return target[name]
			if (name === "measureText") return (text: string) => ({ width: text.length * 8 })
			if (name === "createLinearGradient" || name === "createRadialGradient") return () => ({ addColorStop: () => undefined })
			if (name === "createPattern") return () => null
			if (name === "createImageData" || name === "getImageData")
				return (...args: number[]) => {
					const w = args.length > 2 ? (args[2] ?? 1) : (args[0] ?? 1)
					const h = args.length > 2 ? (args[3] ?? 1) : (args[1] ?? 1)

					return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
				}

			return () => undefined
		},
		set(target, name, value) {
			target[name] = value

			return true
		}
	}) as unknown as Canvas2DLike<RasterImage>

	return {
		width,
		height,
		getContext: () => context,
		transferToImageBitmap: (): RasterImage => ({ width, height, close: () => undefined }),
		close: () => undefined
	} as unknown as RasterCanvas
}

function percentile(values: readonly number[], q: number): number {
	const sorted = [...values].sort((a, b) => a - b)

	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

describe.skipIf(!SLIDES.every(([path]) => existsSync(join(CORPUS_DIR, path))))("showLayersPerf", () => {
	beforeAll(() => {
		installPresentationRealm({
			text: {
				fontHost: nodeFontHost,
				replayFonts: true,
				fontAssets: nodeFontAssets,
				measurer: new HmtxMeasurer(),
				yield: () => Promise.resolve()
			},
			canvas: {
				canvas: (width, height) => nullCanvas(width, height),
				decode: (_bytes, _type, maxSide) => Promise.resolve({ width: maxSide, height: maxSide, close: () => undefined }),
				copy: image => Promise.resolve({ width: image.width, height: image.height, close: () => undefined }),
				fontsReady: () => Promise.resolve()
			}
		})
	})
	afterAll(() => installPresentationRealm(undefined))

	it(
		"prepares each of the 20 most animated slides' layers in ≤ 250 ms of worker CPU and samples frames in ≤ 2 ms",
		{ timeout: 300_000 },
		async ({ task }) => {
			const opened = new Map<string, { session: EngineSession; close: () => void }>()
			let worstLayers = 0
			let worstCompile = 0
			const frames: number[] = []
			let layersDrawn = 0

			for (const [path, slide] of SLIDES) {
				let held = opened.get(path)

				if (held === undefined) {
					const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, path)))
					const odp = path.endsWith(".odp")
					const open = await (odp ? openOdpCapability : openPptxCapability).open({
						source: bytesSource(bytes),
						sourceKind: "bytes",
						options: { format: odp ? "odp" : "pptx", fileName: path }
					})

					if (open.kind !== "opened") throw new Error(`${path}: ${open.kind}`)

					const closers: (() => void)[] = []

					held = {
						session: {
							s: 1,
							deck: open.deck,
							package: open.package,
							emit: () => undefined,
							onClose: (listener: () => void) => closers.push(listener)
						} as unknown as EngineSession,
						close: () => {
							for (const close of closers) close()
						}
					}
					opened.set(path, held)
				}

				const ref = held.session.deck.slides[slide - 1]

				if (ref === undefined) throw new Error(`${path} has no slide ${String(slide)}`)

				const contextOf = (session: EngineSession): CallContext => ({
					session,
					signal: { aborted: false, onAbort: () => undefined },
					lane: "background",
					slicing: { pause: () => new Promise(resolve => setTimeout(resolve, 0)), sliceMs: 8, now: () => performance.now() }
				})
				let best = Infinity
				let source: Awaited<ReturnType<typeof showCapability.timegraph>>["source"]

				// The slide rendered, its timing compiled and its layers drawn, from a session that has not rendered it yet
				// (a new one per run; the deck's parse is kept), the least of 3.
				for (let run = 0; run < 3; run++) {
					const fresh = { ...held.session, onClose: () => undefined } as EngineSession
					const context = contextOf(fresh)
					const start = cpuMs()
					const graph = await showCapability.timegraph(context, ref)

					source = graph.source

					if (source === undefined) throw new Error("no source")

					const layers = await showCapability.layers(context, ref, 1920, layerPlanOf(source, 1))

					best = Math.min(best, cpuMs() - start)
					layersDrawn = Math.max(layersDrawn, layers.length)
				}

				if (source === undefined) throw new Error("no source")

				worstLayers = Math.max(worstLayers, best)

				const compileStart = cpuMs()
				const compiled = compileSource(ref, source, DEFAULT_PRESENTATION_BUDGETS.timing)

				worstCompile = Math.max(worstCompile, cpuMs() - compileStart)

				const instance = instantiate(compiled)

				instance.fire({ kind: "slideBegin" }, 0)

				// Every step a click apart, sampled at 60 fps until the last one's effects are done.
				for (let step = 0; step <= compiled.mainSteps; step++) {
					const at = step * STEP_GAP_MS

					if (step > 0) instance.fire({ kind: "next" }, at)

					for (let t = at; t < at + STEP_GAP_MS; t += FRAME_MS) {
						const start = cpuMs()

						instance.sample(t)
						frames.push(cpuMs() - start)
					}
				}
			}

			for (const held of opened.values()) held.close()

			const p99 = percentile(frames, 0.99)

			Object.assign(task.meta, {
				perf: {
					showLayersWorstCpuMs: { value: worstLayers, budget: 250 },
					showCompileWorstCpuMs: { value: worstCompile, budget: 5 },
					showSampleP99CpuMs: { value: p99, budget: 2 }
				}
			})

			expect(layersDrawn).toBeGreaterThan(1)
			expect(worstLayers).toBeLessThanOrEqual(250)
			expect(worstCompile).toBeLessThanOrEqual(5)
			expect(p99).toBeLessThanOrEqual(2)
		}
	)
})
