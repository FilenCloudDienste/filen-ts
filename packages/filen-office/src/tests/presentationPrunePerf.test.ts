import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { GCProfiler, getHeapStatistics } from "node:v8"
import { describe, expect, it } from "vitest"
import type { ShapeNode, SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { gateSnapshot, pptxSpliceWriter } from "../core/pptx/write/save"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { pptxSaveSource } from "../dom/presentation/engine/save"
import { prunableEntries } from "../dom/presentation/prune"
import { CORPUS_DIR } from "./corpusDir"
import { liveHeap } from "./liveHeap"
import { driveSession } from "./odpWriteDrive"
import { image } from "./presentationObjectsFixtures"
import { budget, cpuMs } from "./timing"

// The save-time prune once a session has authored a part, with 80 of an 81-slide deck's slides deleted: the history
// then holds every deleted slide's parts as bytes (their pictures included), and only markup is searched for names, so
// the prune stays a small part of the save and allocates no copy of the held pictures; the proof a save runs before it
// prunes (gate 2 and every diagram's drawing relationship) stays within its own budget.

const DECK = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")
const BOX: Xfrm = { x: 0, y: 0, cx: 100_000, cy: 100_000, rot: 0, flipH: false, flipV: false }
const CPU_MS = 25
const ALLOCATED_MB = 32
const RETAINED_MB = 1
const PROOF_CPU_MS = 25

// The bytes `run` allocates on the heap: its growth plus what every collection during it freed.
async function allocatedBy<T>(run: () => Promise<T>): Promise<{ result: T; bytes: number }> {
	const profiler = new GCProfiler()
	const start = getHeapStatistics().used_heap_size

	profiler.start()

	const result = await run()
	const end = getHeapStatistics().used_heap_size
	let freed = 0

	for (const gc of profiler.stop()?.statistics ?? [])
		freed += Math.max(0, gc.beforeGC.heapStatistics.usedHeapSize - gc.afterGC.heapStatistics.usedHeapSize)

	return { result, bytes: end - start + freed }
}

describe.skipIf(!existsSync(DECK))("save-time prune performance", () => {
	it(`prunes after 80 of 81 slides are deleted within ${String(CPU_MS)} ms of CPU`, { timeout: 300_000 }, async ({ task }) => {
		const d = await driveSession(new Uint8Array(readFileSync(DECK)), "pptx")
		const parts = pptxParts(d.session.deck)

		for (const ref of d.session.deck.slides) await parts?.slide(ref)

		// A picture written by a save and replaced by the next: the session has authored parts, so every save prunes.
		const slide = d.session.deck.slides[0] as SlideRef
		const shape = { id: 0, name: "Picture", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode

		expect((await d.command({ family: "picture", kind: "insert", slide, shape, image: image(64, 32) })).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")

		const id = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.name === "Picture")?.id ?? 0

		expect((await d.command({ family: "picture", kind: "replace", target: { slide, id }, image: image(70, 32) })).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.command({ family: "slide", kind: "delete", slides: d.session.deck.slides.slice(1) })).ok).toBe(true)

		const before = await liveHeap()
		let best = Number.POSITIVE_INFINITY
		let allocated = 0

		for (let attempt = 0; attempt < 3; attempt++) {
			await liveHeap()

			const start = cpuMs()
			const pruned = await allocatedBy(() => prunableEntries(d.session))

			best = Math.min(best, cpuMs() - start)
			allocated = Math.max(allocated, pruned.bytes)
			expect(pruned.result).toEqual([])
		}

		const retained = (await liveHeap()) - before
		// The proof a save runs before it prunes (gate 2 with the diagram drawing check), on this deck's snapshot.
		const snapshot = await pptxSpliceWriter.snapshot({
			deck: d.session.deck,
			source: pptxSaveSource(d.session),
			changes: sessionEdits(d.session).changes(),
			revision: sessionEdits(d.session).history.revision
		})

		if (!("changes" in snapshot)) throw new Error(snapshot.reason)

		let gate = Number.POSITIVE_INFINITY

		for (let attempt = 0; attempt < 3; attempt++) {
			const start = cpuMs()

			expect(await gateSnapshot(snapshot, new Set())).toBeUndefined()
			gate = Math.min(gate, cpuMs() - start)
		}

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")
		Object.assign(task.meta, {
			perf: {
				pruneMassDeleteCpuMs: { value: best, budget: CPU_MS },
				pruneMassDeleteAllocatedMb: { value: allocated / 2 ** 20, budget: ALLOCATED_MB },
				pruneProofMassDeleteCpuMs: { value: gate, budget: PROOF_CPU_MS }
			}
		})
		expect(best).toBeLessThanOrEqual(budget(CPU_MS))
		expect(allocated / 2 ** 20).toBeLessThanOrEqual(ALLOCATED_MB)
		expect(retained / 2 ** 20).toBeLessThanOrEqual(RETAINED_MB)
		expect(gate).toBeLessThanOrEqual(budget(PROOF_CPU_MS))
	})
})
