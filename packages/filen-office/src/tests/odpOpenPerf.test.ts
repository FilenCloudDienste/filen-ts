import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ByteSource } from "@filen/office/core/opc"
import { openOdp } from "../core/odp/read/document"
import type { RenderServices } from "../core/presentation/render/services"
import { renderSlide } from "../core/presentation/render/slide"
import type { Slicing } from "../core/slicing"
import { CORPUS_DIR } from "./corpusDir"
import { budget, cpuMs } from "./timing"

// Opening odftk Presentation3.odp (1,000 pages, 2.4 MB of content.xml, 553 embedded objects) to its first slide
// rendered, from a range source: the package, styles and masters, the page scan, the first page's parse and its
// render. Pages are parsed lazily: after the first slide only it is in the model. The least CPU of three warm runs;
// the heap the open deck holds, after a collection (node --expose-gc).

const DECK = join(CORPUS_DIR, "odp", "odftk__Presentation3.odp")
const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 1e9, now: () => 0 }

// Positional reads of the file, as a range port serves them (no whole-file buffer handed to the reader).
function rangeSource(bytes: Uint8Array): ByteSource & { reads: number } {
	const source = {
		size: bytes.length,
		reads: 0,
		read(offset: number, length: number): Promise<Uint8Array> {
			source.reads++

			return Promise.resolve(bytes.slice(offset, offset + length))
		}
	}

	return source
}

function heapMb(): number {
	const gc: unknown = Reflect.get(globalThis, "gc")

	if (typeof gc === "function") Reflect.apply(gc, globalThis, [])

	const usage = process.memoryUsage()

	// The JS heap and the typed arrays outside it (inflated streams, parsed documents' bytes).
	return (usage.heapUsed + usage.arrayBuffers) / (1024 * 1024)
}

describe.skipIf(!existsSync(DECK))("odpOpenPerf", () => {
	it(
		"opens the 1,000-page deck to its first slide rendered in at most 1.5 s CPU, pages lazy, within 300 MB",
		{ timeout: budget(120_000) },
		async ({ task }) => {
			const bytes = new Uint8Array(readFileSync(DECK))
			let best = Number.POSITIVE_INFINITY
			let openOnly = Number.POSITIVE_INFINITY
			let held = 0

			for (let run = 0; run < 4; run++) {
				const before = heapMb()
				const start = cpuMs()
				const open = await openOdp(rangeSource(bytes))

				if (open.kind !== "opened") throw new Error(open.reason)

				const opened = cpuMs() - start
				const [first] = open.deck.slides

				if (first === undefined) throw new Error("no slides")

				const node = await open.parts.slide(first)
				const services: RenderServices = {
					xml: part => open.parts.document(part),
					relationship: () => undefined,
					contentType: part => open.parts.contentTypes.typeOf(part),
					budgets: open.parts.budgets
				}
				const render = await renderSlide(open.deck, first, services, SLICING)
				const spent = cpuMs() - start

				expect(render.layers.length).toBe(node.shapes.filter(shape => !shape.hidden).length)
				expect(open.deck.slides).toHaveLength(1000)
				expect(open.deck.slides.filter(ref => open.deck.nodes.has(ref))).toEqual([first])

				// The first run warms the engine (module code, caches of the shared engines).
				if (run > 0) {
					best = Math.min(best, spent)
					openOnly = Math.min(openOnly, opened)
					held = Math.max(held, heapMb() - before)
				}
			}

			Object.assign(task.meta, {
				perf: {
					odpFirstSlideCpuMs: { value: best, budget: 1500 },
					odpOpenCpuMs: { value: openOnly },
					odpOpenHeapMB: { value: held, budget: 300 }
				}
			})
			expect(best).toBeLessThanOrEqual(1500)
			expect(held).toBeLessThanOrEqual(300)
		}
	)
})
