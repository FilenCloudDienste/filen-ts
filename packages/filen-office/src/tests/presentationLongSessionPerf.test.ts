import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ShapeRef, Xfrm } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { viewCapability } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { CORPUS_DIR } from "./corpusDir"
import { installTestRealm } from "./presentationExportFixtures"
import { liveHeap } from "./liveHeap"
import { driveSession } from "./odpWriteDrive"
import { budget, cpuMs } from "./timing"

// A long editing session, as the worker runs it over a drive with versioning off: 500 edits over ten slides, saved
// after every tenth (50 saves, each uploaded, committed and rebased, the slides drawn again after it). What the session holds once the slides it edits
// are read and it has saved once, against what it holds after the last save: the growth is what it keeps per edit and
// per save (the undo history's steps among it), never a reading, a package or a snapshot per save.

const MiB = 1024 * 1024
const EDITS = 500
const SAVE_EVERY = 10
const SLIDES = 10
const GROWTH_BUDGET = 8 * MiB

const DECKS = [
	{ path: "pptx/govuk__Shaping_the_Qualifications_Landscape.pptx", format: "pptx" },
	{ path: "odp/odftk__Presentation3.odp", format: "odp" }
] as const

// The live heap once the work's last continuations have run (a timer turn) and its buffers are released.
async function settled(): Promise<number> {
	await new Promise(resolve => setTimeout(resolve, 20))

	return await liveHeap()
}

describe.skipIf(!DECKS.every(deck => existsSync(join(CORPUS_DIR, deck.path))))("presentationLongSessionPerf", () => {
	beforeAll(installTestRealm)
	afterAll(() => installPresentationRealm(undefined))

	for (const deck of DECKS) {
		const name = `${deck.path.replace(/^\w+\/\w+__|\.\w+$/g, "").replace(/\W/g, "")}_${deck.format}`

		it(
			`keeps ${name}'s memory flat over ${String(EDITS)} edits and ${String(EDITS / SAVE_EVERY)} saves`,
			{ timeout: budget(900_000) },
			async ({ task }) => {
				const d = await driveSession(new Uint8Array(readFileSync(join(CORPUS_DIR, deck.path))), deck.format)
				const targets: { readonly shape: ShapeRef; readonly xfrm: Xfrm }[] = []

				for (const slide of d.session.deck.slides) {
					if (targets.length === SLIDES) break

					const node = await (odpParts(d.session.deck) ?? pptxParts(d.session.deck))?.slide(slide)
					const shape = node?.shapes.find(
						candidate => candidate.kind === "sp" && candidate.xfrm !== undefined && candidate.lock === undefined
					)

					if (shape?.xfrm !== undefined) targets.push({ shape: { slide, id: shape.id }, xfrm: shape.xfrm })
				}

				expect(targets).toHaveLength(SLIDES)

				const edit = async (k: number): Promise<void> => {
					const target = targets[k % SLIDES]

					if (target === undefined) throw new Error("no target")

					const result =
						k % 2 === 0
							? await d.command({
									family: "shape",
									kind: "setXfrm",
									target: target.shape,
									xfrm: { ...target.xfrm, x: target.xfrm.x + 12700 * ((k % 7) + 1) }
								})
							: await d.command({
									family: "shape",
									kind: "setAlt",
									target: target.shape,
									alt: { descr: `Edit ${String(k)}` }
								})

					expect(result).toMatchObject({ ok: true })
				}
				// A save, then the edited slides drawn again as the page does.
				const save = async (): Promise<void> => {
					expect((await d.save()).result.kind).toBe("written")
					await viewCapability.render(
						d.context,
						targets.map(target => target.shape.slide)
					)
				}

				// Every slide read and edited once, and a save: what the session holds from then on.
				for (let k = 0; k < SLIDES; k++) await edit(k)

				await save()

				const start = (await settled()) - d.drive.held()
				const cpu = cpuMs()
				let saveCpu = 0

				for (let k = 0; k < EDITS; k++) {
					await edit(SLIDES + k)

					if ((k + 1) % SAVE_EVERY === 0) {
						const begun = cpuMs()

						await save()
						saveCpu = Math.max(saveCpu, cpuMs() - begun)
					}
				}

				const spent = cpuMs() - cpu
				const growth = (await settled()) - d.drive.held() - start

				Object.assign(task.meta, {
					perf: {
						[`${name}LongSessionGrowthMiB`]: { value: growth / MiB, budget: GROWTH_BUDGET / MiB },
						[`${name}LongSessionCpuMs`]: { value: spent },
						[`${name}LongSessionWorstSaveCpuMs`]: { value: saveCpu }
					}
				})
				expect(growth).toBeLessThanOrEqual(GROWTH_BUDGET)
			}
		)
	}
})
