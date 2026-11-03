import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { IN_MEMORY_LIMIT } from "../core/pptx/write/save"
import type { ShapeNode, SlideNode } from "../core/presentation/model"
import { viewCapability } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { CORPUS_DIR } from "./corpusDir"
import { installTestRealm } from "./presentationExportFixtures"
import { liveHeap, liveHeapNow } from "./liveHeap"
import { driveSession } from "./odpWriteDrive"
import { budget, cpuMs } from "./timing"

// The corpus's biggest decks through the session as the worker runs it, range-backed over a drive with versioning off:
// open to the first slide rendered, one shape moved on the fourth slide, then a save with its upload, commit and
// rebase. CPU per phase, the least of three runs. Memory (liveHeap.ts; what the drive holds is the server's, left out):
// the live heap the open deck holds, the peak above the edited deck while the save runs, and what the committed save
// leaves behind (a package up to the in-memory limit is kept as the session's source, so the rebase reads no download).

const MiB = 1024 * 1024
// What the session may hold after a save beyond the package it keeps.
const LEFT_SLACK = 8 * MiB

interface LargeDeck {
	readonly path: string
	readonly format: "pptx" | "odp"
	// §1.12's open and save rows of the format.
	readonly openCpuMs: number
	readonly modelMiB: number
	readonly saveCpuMs: number
	readonly savePeakMiB: number
}

const PPTX = { format: "pptx", openCpuMs: 400, modelMiB: 150, saveCpuMs: 600, savePeakMiB: 32 } as const
const ODP = { format: "odp", openCpuMs: 1500, modelMiB: 300, saveCpuMs: 2000, savePeakMiB: 64 } as const
const DECKS: readonly LargeDeck[] = [
	// The corpus's largest package (96 MB, past the in-memory limit: its save streams).
	{ path: "pptx/govuk__AiG_Month_Guide_for_Organisers.pptx", ...PPTX },
	{ path: "pptx/govuk__Shaping_the_Qualifications_Landscape.pptx", ...PPTX },
	// The largest ODP package, and the ODP with the most pages (1,000).
	{ path: "odp/govuk__Shaping_the_Qualifications_Landscape.odp", ...ODP },
	{ path: "odp/odftk__Presentation3.odp", ...ODP }
]
const RUNS = 3

function movable(node: SlideNode | undefined): ShapeNode | undefined {
	return node?.shapes.find(shape => shape.xfrm !== undefined && shape.lock === undefined && shape.kind === "sp")
}

// The live heap once the work's last continuations have run (a timer turn) and its buffers are released.
async function settled(): Promise<number> {
	await new Promise(resolve => setTimeout(resolve, 20))

	return await liveHeap()
}

describe.skipIf(!DECKS.every(deck => existsSync(join(CORPUS_DIR, deck.path))))("presentationLargeDeckPerf", () => {
	beforeAll(installTestRealm)
	afterAll(() => installPresentationRealm(undefined))

	for (const large of DECKS) {
		const name = `${large.path.replace(/^\w+\/\w+__|\.\w+$/g, "").replace(/\W/g, "")}_${large.format}`

		it(
			`opens, edits and saves ${name} within the open and save budgets, its memory bounded`,
			{ timeout: budget(600_000) },
			async ({ task }) => {
				const file = new Uint8Array(readFileSync(join(CORPUS_DIR, large.path)))
				const best = { open: Infinity, edit: Infinity, save: Infinity }
				const memory = { model: 0, peak: 0, left: 0 }

				// Each run in a frame of its own, so nothing of one run (the saved file it was handed) is held into the next.
				const run = async (measured: boolean): Promise<void> => {
					let held = (): number => 0
					let top = 0
					let samples = 0
					let base = Number.POSITIVE_INFINITY
					// Every 16th read or chunk of the drive (each sample is two full collections).
					const sample = (): void => {
						if (base !== Number.POSITIVE_INFINITY && samples++ % 16 === 0) top = Math.max(top, liveHeapNow() - held() - base)
					}
					const before = measured ? await settled() : 0
					let start = cpuMs()
					// The drive's own copy: everything it holds is the server's.
					const d = await driveSession(file.slice(), large.format, [], { sample })

					held = () => d.drive.held()

					const [first, , , fourth] = d.session.deck.slides

					if (first === undefined || fourth === undefined) throw new Error("too few slides")

					await viewCapability.render(d.context, [first])
					best.open = Math.min(best.open, cpuMs() - start)

					if (measured) memory.model = (await settled()) - held() - before

					start = cpuMs()
					await viewCapability.render(d.context, [fourth])

					const shape = movable(d.session.deck.nodes.get(fourth))

					if (shape?.xfrm === undefined) throw new Error("no shape to move")

					expect(
						await d.command({
							family: "shape",
							kind: "setXfrm",
							target: { slide: fourth, id: shape.id },
							xfrm: { ...shape.xfrm, x: shape.xfrm.x + 12700 }
						})
					).toMatchObject({ ok: true })
					best.edit = Math.min(best.edit, cpuMs() - start)

					const edited = measured ? (await settled()) - held() : 0

					if (measured) base = edited

					start = cpuMs()
					expect((await d.save()).result.kind).toBe("written")
					best.save = Math.min(best.save, cpuMs() - start)
					base = Number.POSITIVE_INFINITY

					if (measured) {
						memory.peak = top
						memory.left = (await settled()) - held() - edited
					}
				}

				for (let k = 0; k < RUNS; k++) await run(k === RUNS - 1)

				const leftBudget = (file.length <= IN_MEMORY_LIMIT ? file.length : 0) + LEFT_SLACK

				Object.assign(task.meta, {
					perf: {
						[`${name}OpenCpuMs`]: { value: best.open, budget: large.openCpuMs },
						[`${name}EditCpuMs`]: { value: best.edit },
						[`${name}SaveCpuMs`]: { value: best.save, budget: large.saveCpuMs },
						[`${name}ModelMiB`]: { value: memory.model / MiB, budget: large.modelMiB },
						[`${name}SavePeakMiB`]: { value: memory.peak / MiB, budget: large.savePeakMiB },
						[`${name}SaveLeftMiB`]: { value: memory.left / MiB, budget: leftBudget / MiB }
					}
				})
				expect(best.open).toBeLessThanOrEqual(budget(large.openCpuMs))
				expect(best.save).toBeLessThanOrEqual(budget(large.saveCpuMs))
				expect(memory.model).toBeLessThanOrEqual(large.modelMiB * MiB)
				expect(memory.peak).toBeLessThanOrEqual(large.savePeakMiB * MiB)
				expect(memory.left).toBeLessThanOrEqual(leftBudget)
			}
		)
	}
})
