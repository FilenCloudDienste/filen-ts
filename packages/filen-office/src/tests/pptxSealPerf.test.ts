import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync, zipSync } from "fflate"
import { describe, expect, it, vi } from "vitest"
import { bytesSource, memorySink, ZipArchive, type ByteSink, type Slicing } from "@filen/office/core/opc"
import { agileStreams, encryptedOfficeFile } from "@filen/office/testing/encryption"
import { openPptx } from "../core/pptx/package"
import { savePptxSealed } from "../core/pptx/write/seal"
import { openEncryptedPackage } from "../dom/encryption/index"
import { packageSealer } from "../dom/encryption/seal"
import { CORPUS_DIR } from "./corpusDir"
import { liveHeapNow } from "./liveHeap"
import { budget, cpuMs } from "./timing"
import { Changes } from "./pptxWriteFixtures"

// The encrypted save of a 30 MB deck (govuk Shaping with a stored 13 MB medium, Agile): one shape moved, the zip in
// memory with gate 2, sealed under the session's key and read back by the sealer. The least CPU of three runs, then
// one run measured for memory: the save's slicing pause, the end of the compound-file build and every chunk handed to
// the sink sample this process's live heap (liveHeap.ts); its rise above the opened deck is held against the package
// size. The peak is the build: the zip, the EncryptedPackage stream and the compound file holding it, about 3.0×.

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
			const plain = thirtyMegabytes()
			const file = await encryptedOfficeFile(agileStreams(plain, PASSWORD, { spinCount: 1000 }))
			const open = await openEncryptedPackage(bytesSource(file))

			if (open.kind !== "needsPassword") throw new Error(open.kind)

			const unlocked = await open.locked.unlock(PASSWORD)

			if (!unlocked.ok) throw new Error(unlocked.reason)

			const decrypted = unlocked.document
			const { sealer, release } = packageSealer(decrypted.key)
			let best = Number.POSITIVE_INFINITY
			let peak = 0

			try {
				// Three timed runs, then one measured for memory.
				for (let run = 0; run < 4; run++) {
					const measured = run === 3
					const deck = await openPptx(bytesSource(decrypted.bytes))

					if (deck.kind !== "opened") throw new Error(deck.reason)

					const ref = deck.deck.slides[3]

					if (ref === undefined) throw new Error("no slide")

					const node = await deck.parts.slide(ref)
					const shape = node.shapes.find(
						candidate => candidate.kind === "sp" && candidate.xfrm !== undefined && candidate.lock === undefined
					)

					if (shape?.xfrm === undefined) throw new Error("no shape")

					shape.xfrm = { ...shape.xfrm, x: shape.xfrm.x + 12700 }

					const source = {
						archive: await ZipArchive.open(bytesSource(decrypted.bytes)),
						package: deck.parts.opc,
						index: deck.parts
					}
					const input = {
						deck: deck.deck,
						source,
						changes: new Changes().shape(node.part, shape.id, { kind: "xfrm" }).build(),
						revision: 1
					}

					if (!measured) {
						const start = cpuMs()
						const outcome = await savePptxSealed(input, sealer, memorySink())

						best = Math.min(best, cpuMs() - start)

						if (outcome.kind !== "written") throw new Error(JSON.stringify(outcome))

						continue
					}

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
					// Drops what it gets, as the save port's writer does.
					const sink: ByteSink = {
						write: chunk => {
							written += chunk.length
							sample()

							return Promise.resolve()
						},
						close: () => Promise.resolve()
					}
					const before = liveHeapNow()

					hook.sample = sample

					const outcome = await savePptxSealed(input, sealer, sink, { slicing }).finally(() => {
						hook.sample = undefined
					})

					if (outcome.kind !== "written" || written === 0) throw new Error(JSON.stringify(outcome))

					peak = top - before
				}
			} finally {
				release()
			}

			const ratio = peak / decrypted.bytes.length

			Object.assign(task.meta, {
				perf: { pptxSealCpuMs: { value: best, budget: 1500 }, pptxSealPeakRatio: { value: ratio, budget: 3.1 } }
			})
			expect(best).toBeLessThanOrEqual(budget(1500))
			expect(peak).toBeGreaterThan(0)
			expect(ratio).toBeLessThanOrEqual(3.1)
		}
	)
})
