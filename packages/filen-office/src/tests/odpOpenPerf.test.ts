import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ByteSource } from "@filen/office/core/opc"
import { openOdp } from "../core/odp/read/document"
import type { RenderServices } from "../core/presentation/render/services"
import { renderSlide } from "../core/presentation/render/slide"
import type { Slicing } from "../core/slicing"
import { CORPUS_DIR } from "./corpusDir"
import { liveHeap } from "./liveHeap"
import { budget, cpuMs } from "./timing"

// Opening odftk Presentation3.odp (1,000 pages, 2.4 MB of content.xml, 553 embedded objects) to its first slide
// rendered, from a range source: the package, styles and masters, the page scan, the first page's parse and its
// render. Pages are parsed lazily: after the first slide only it is in the model. The least CPU of three warm runs;
// the live heap the open deck and its first render hold. A single synchronous collection leaves the backing stores of
// the open's transient buffers (tens of MB, released off the thread) counted, so the reading waits a turn for them.

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

// The package, styles and masters, the page scan, then the first page's parse and its render.
async function openFirst(bytes: Uint8Array): Promise<{ opened: number; spent: number; held: () => number }> {
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

	// The open deck and its render stay reachable for as long as the caller keeps this.
	return { opened, spent, held: () => open.deck.slides.length + render.layers.length }
}

// A call of its own, so that the deck is unreachable once it returns (a loop's binding in an async function lives on in
// its context until the next iteration overwrites it, past the next run's first reading).
async function heldMb(bytes: Uint8Array): Promise<number> {
	const before = await liveHeap()
	const opened = await openFirst(bytes)
	const held = ((await liveHeap()) - before) / (1024 * 1024)

	expect(opened.held()).toBeGreaterThan(0)

	return held
}

describe.skipIf(!existsSync(DECK))("odpOpenPerf", () => {
	it(
		"opens the 1,000-page deck to its first slide rendered in at most 1.5 s CPU, pages lazy, holding at most 13 MB",
		{ timeout: budget(120_000) },
		async ({ task }) => {
			const bytes = new Uint8Array(readFileSync(DECK))
			let best = Number.POSITIVE_INFINITY
			let openOnly = Number.POSITIVE_INFINITY

			// The first run warms the engine (module code, caches of the shared engines).
			for (let run = 0; run < 4; run++) {
				const { opened, spent } = await openFirst(bytes)

				if (run > 0) {
					best = Math.min(best, spent)
					openOnly = Math.min(openOnly, opened)
				}
			}

			// Runs of their own: the forced collections flush the engine's aged bytecode, which would bill its recompilation
			// to the timed runs, and the first of these recompiles it, so only the second reads what the open deck holds.
			await heldMb(bytes)

			const held = await heldMb(bytes)

			Object.assign(task.meta, {
				perf: {
					odpFirstSlideCpuMs: { value: best, budget: 1500 },
					odpOpenCpuMs: { value: openOnly },
					odpOpenHeapMB: { value: held, budget: 13 }
				}
			})
			expect(best).toBeLessThanOrEqual(1500)
			expect(held).toBeLessThanOrEqual(13)
		}
	)
})
