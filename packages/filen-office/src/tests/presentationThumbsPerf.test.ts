import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Canvas2DLike, CanvasGradientLike, ImageDataLike } from "../core/drawingml/canvas"
import { bytesSource } from "../core/opc/index"
import type { CallContext, EngineSession } from "../dom/presentation/engine"
import { thumbsCapabilityOf } from "../dom/presentation/engine/thumbs"
import { openPptxCapability } from "../dom/presentation/engine/open/pptx"
import { readPart, renderSlideFor } from "../dom/presentation/engine/view"
import type { PresentationEvent } from "../dom/presentation/protocol"
import { installPresentationRealm, type RasterCanvas, type RasterImage } from "../dom/presentation/services"
import { CORPUS_DIR } from "./corpusDir"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { cpuMs } from "./timing"

// Thumbnails of the 81-slide govuk Shaping deck at 192 px: each slide parsed, rendered, its text laid out and painted
// through the canvas painters, as the worker does, minus the browser's rasterisation (a canvas that draws nothing; the
// harness measures the browsers). Budget: a thumbnail ≤ 25 ms median, all 81 ≤ 2.5 s of CPU, yielding every 8 ms.

const DECK = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")

class NullCanvas implements Canvas2DLike<RasterImage>, RasterCanvas {
	readonly width: number
	readonly height: number
	globalAlpha = 1
	globalCompositeOperation = "source-over"
	fillStyle: unknown = "#000"
	strokeStyle: unknown = "#000"
	lineWidth = 1
	lineCap = "butt"
	lineJoin = "miter"
	miterLimit = 10
	font = "10px sans-serif"
	textAlign = "start"
	textBaseline = "alphabetic"
	direction = "ltr"
	letterSpacing = "0px"
	wordSpacing = "0px"
	shadowColor = "transparent"
	shadowBlur = 0
	shadowOffsetX = 0
	shadowOffsetY = 0

	constructor(width = 0, height = 0) {
		this.width = width
		this.height = height
	}

	getContext(): Canvas2DLike<RasterImage> {
		return this
	}
	transferToImageBitmap(): RasterImage {
		return { width: this.width, height: this.height, close: () => undefined }
	}
	close(): void {}
	save(): void {}
	restore(): void {}
	setTransform(): void {}
	beginPath(): void {}
	moveTo(): void {}
	lineTo(): void {}
	bezierCurveTo(): void {}
	quadraticCurveTo(): void {}
	closePath(): void {}
	rect(): void {}
	fill(): void {}
	stroke(): void {}
	clip(): void {}
	fillRect(): void {}
	clearRect(): void {}
	setLineDash(): void {}
	createLinearGradient(): CanvasGradientLike {
		return { addColorStop: () => undefined }
	}
	createRadialGradient(): CanvasGradientLike {
		return { addColorStop: () => undefined }
	}
	createPattern(): null {
		return null
	}
	drawImage(): void {}
	fillText(): void {}
	strokeText(): void {}
	measureText(text: string): { readonly width: number } {
		return { width: text.length * 8 }
	}
	createImageData(width: number, height: number): ImageDataLike {
		return { width, height, data: new Uint8ClampedArray(width * height * 4) }
	}
	getImageData(_x: number, _y: number, width: number, height: number): ImageDataLike {
		return this.createImageData(width, height)
	}
	putImageData(): void {}
}

describe.skipIf(!existsSync(DECK))("presentationThumbsPerf", () => {
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
				canvas: (width, height) => new NullCanvas(width, height),
				decode: () => Promise.resolve({ width: 192, height: 192, close: () => undefined }),
				copy: image => Promise.resolve({ width: image.width, height: image.height, close: () => undefined }),
				fontsReady: () => Promise.resolve()
			}
		})
	})
	afterAll(() => installPresentationRealm(undefined))

	it("draws a 192 px thumbnail in ≤ 25 ms median and all 81 in ≤ 2.5 s of CPU", { timeout: 120_000 }, async ({ task }) => {
		const bytes = new Uint8Array(readFileSync(DECK))
		let best = Infinity
		let medians = Infinity
		let slices = 0

		for (let run = 0; run < 3; run++) {
			const opened = await openPptxCapability.open({
				source: bytesSource(bytes),
				sourceKind: "bytes",
				options: { format: "pptx", fileName: "deck.pptx" }
			})

			if (opened.kind !== "opened") throw new Error(`open: ${opened.kind}`)

			const closers: (() => void)[] = []
			const events: PresentationEvent[] = []
			const session = {
				s: 1,
				deck: opened.deck,
				package: opened.package,
				emit: (event: PresentationEvent) => events.push(event),
				onClose: (listener: () => void) => closers.push(listener)
			} as unknown as EngineSession
			const each: number[] = []
			let last = cpuMs()
			const context: CallContext = {
				session,
				signal: { aborted: false, onAbort: () => undefined },
				lane: "background",
				slicing: {
					pause: () => {
						slices++

						return new Promise(resolve => setTimeout(resolve, 0))
					},
					sliceMs: 8,
					now: () => performance.now()
				}
			}
			const timed = thumbsCapabilityOf(async (call, ref) => {
				const render = await renderSlideFor(call, ref)

				return render
			}, readPart)
			const start = cpuMs()

			for (const ref of opened.deck.slides) {
				await timed.thumbnails(context, [ref], 192)

				const now = cpuMs()

				each.push(now - last)
				last = now
			}

			best = Math.min(best, cpuMs() - start)
			each.sort((a, b) => a - b)
			medians = Math.min(medians, each[Math.floor(each.length / 2)] ?? Infinity)

			expect(events.filter(event => event.type === "thumbs").length).toBe(81)

			for (const close of closers) close()
		}

		Object.assign(task.meta, {
			perf: { thumbnailMedianCpuMs: { value: medians, budget: 25 }, thumbnails81CpuMs: { value: best, budget: 2500 } }
		})

		expect(medians).toBeLessThanOrEqual(25)
		expect(best).toBeLessThanOrEqual(2500)
		expect(slices).toBeGreaterThan(0)
	})
})
