import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync, zipSync } from "fflate"
import { describe, expect, it, vi } from "vitest"
import type { Slicing } from "@filen/office/core/opc"
import { agileStreams, encryptedOfficeFile } from "@filen/office/testing/encryption"
import { CORPUS_DIR } from "./corpusDir"
import { liveHeapNow } from "./liveHeap"
import { openSealedSession, type SealedSession } from "./sealedSaveHarness"
import { budget, cpuMs } from "./timing"

// The encrypted save of a 30 MB deck (govuk Shaping with a stored 13 MB medium, Agile) as a user runs it (saveSession
// with the shipped dependencies, the upload reading the save port): one shape moved, the zip in memory with gate 2,
// sealed under the session's key and read back by the sealer. The least CPU of three runs, then one run measured for
// memory: the save's slicing pause, the end of the compound-file build and every chunk the upload reads sample this
// process's live heap (liveHeap.ts); its rise above the opened deck is held against the package size. The peak is the
// build: the zip, the EncryptedPackage stream and the compound file holding it.

// The compound file is built in one go with no pause inside it, so the build is sampled as it returns, while its
// EncryptedPackage stream is still held. Only the measured run sets the sampler.
const hook = vi.hoisted(() => ({ sample: undefined as (() => void) | undefined }))

vi.mock(import("../core/cfb/writer"), async importOriginal => {
	const writer = await importOriginal()

	return {
		...writer,
		cfbBytes: async (...args: Parameters<typeof writer.cfbBytes>) => {
			const bytes = await writer.cfbBytes(...args)

			hook.sample?.()

			return bytes
		}
	}
})

const SHAPING = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")
const PASSWORD = "perf"

function thirtyMegabytes(): Uint8Array {
	const parts = unzipSync(new Uint8Array(readFileSync(SHAPING)))
	const filler = new Uint8Array(13.5 * 1024 * 1024)
	let seed = 7

	for (let k = 0; k < filler.length; k++) {
		seed = (seed * 1103515245 + 12345) >>> 0
		filler[k] = seed >>> 24
	}

	const entries = Object.fromEntries(
		Object.entries(parts).map(([name, data]) => [name, [data, { level: name.startsWith("ppt/media/") ? 0 : 6 }] as const])
	)

	return zipSync({ ...entries, "ppt/media/filler.bin": [filler, { level: 0 }] })
}

// A slice of work between samples: each sample is two full collections.
const SAMPLE_MS = 20

describe.skipIf(!existsSync(SHAPING))("pptxSealPerf", () => {
	it(
		"saves a 30 MB encrypted deck with one shape edited in at most 1.5 s CPU, holding at most 3.1× the package",
		{ timeout: budget(300_000) },
		async ({ task }) => {
			const file = await encryptedOfficeFile(agileStreams(thirtyMegabytes(), PASSWORD, { spinCount: 1000 }))
			let size = 0
			let best = Number.POSITIVE_INFINITY
			let peak = 0

			// A fresh session per run, one shape on slide 4 moved.
			const edited = async (): Promise<SealedSession> => {
				const session = await openSealedSession(file, PASSWORD)
				const node = await session.slide(3)
				const shape = node.shapes.find(
					candidate => candidate.kind === "sp" && candidate.xfrm !== undefined && candidate.lock === undefined
				)

				if (shape?.xfrm === undefined) throw new Error("no shape")

				shape.xfrm = { ...shape.xfrm, x: shape.xfrm.x + 12700 }
				session.moved(node, shape.id)
				size = session.packageBytes

				return session
			}

			// Three timed runs, then one measured for memory.
			for (let run = 0; run < 3; run++) {
				const session = await edited()

				try {
					const start = cpuMs()
					const saved = await session.save({ chunk: () => undefined })

					best = Math.min(best, cpuMs() - start)

					if (saved.result.kind !== "written") throw new Error(JSON.stringify(saved.result))
				} finally {
					session.close()
				}
			}

			const session = await edited()

			try {
				let top = 0
				let written = 0
				const sample = (): void => {
					top = Math.max(top, liveHeapNow())
				}
				const slicing: Slicing = {
					pause: () => {
						sample()

						return Promise.resolve()
					},
					sliceMs: SAMPLE_MS,
					now: () => performance.now()
				}
				const before = liveHeapNow()

				hook.sample = sample

				// The upload drops what it reads, as the SDK worker's does once a chunk is sent.
				const saved = await session
					.save({
						slicing,
						chunk: bytes => {
							written += bytes.length
							sample()
						}
					})
					.finally(() => {
						hook.sample = undefined
					})

				if (saved.result.kind !== "written" || written === 0) throw new Error(JSON.stringify(saved.result))

				peak = top - before
			} finally {
				session.close()
			}

			const ratio = peak / size

			Object.assign(task.meta, {
				perf: { pptxSealCpuMs: { value: best, budget: 1500 }, pptxSealPeakRatio: { value: ratio, budget: 3.1 } }
			})
			expect(best).toBeLessThanOrEqual(budget(1500))
			expect(peak).toBeGreaterThan(0)
			expect(ratio).toBeLessThanOrEqual(3.1)
		}
	)
})
