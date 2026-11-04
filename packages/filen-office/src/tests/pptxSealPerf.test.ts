import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { bytesSource, memorySink, ZipArchive } from "@filen/office/core/opc"
import { agileStreams, encryptedOfficeFile } from "@filen/office/testing/encryption"
import { openPptx } from "../core/pptx/package"
import { savePptxSealed } from "../core/pptx/write/seal"
import { openEncryptedPackage } from "../dom/encryption/index"
import { packageSealer } from "../dom/encryption/seal"
import { CORPUS_DIR } from "./corpusDir"
import { budget, cpuMs } from "./timing"
import { Changes } from "./pptxWriteFixtures"

// The encrypted save of a 30 MB deck (govuk Shaping with a stored 13 MB medium, Agile): one shape moved, the zip in
// memory with gate 2, sealed under the session's key and read back by the sealer. The least CPU of three runs, and
// the memory the save holds at its peak (the zip and the sealed file) against the package size.

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

describe.skipIf(!existsSync(SHAPING))("pptxSealPerf", () => {
	it(
		"saves a 30 MB encrypted deck with one shape edited in at most 1.5 s CPU, holding at most 2.1× the package",
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
			let held = 0

			try {
				for (let run = 0; run < 3; run++) {
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
					const sink = memorySink()
					const start = cpuMs()
					const outcome = await savePptxSealed(
						{
							deck: deck.deck,
							source,
							changes: new Changes().shape(node.part, shape.id, { kind: "xfrm" }).build(),
							revision: 1
						},
						sealer,
						sink
					)

					best = Math.min(best, cpuMs() - start)

					if (outcome.kind !== "written") throw new Error(JSON.stringify(outcome))

					// What the save holds at its peak: the zip (its report's size) and the sealed file.
					held = Math.max(held, outcome.report.size + sink.bytes().length)
				}
			} finally {
				release()
			}

			const ratio = held / decrypted.bytes.length

			Object.assign(task.meta, {
				perf: { pptxSealCpuMs: { value: best, budget: 1500 }, pptxSealPeakRatio: { value: ratio, budget: 2.1 } }
			})
			expect(best).toBeLessThanOrEqual(budget(1500))
			expect(ratio).toBeLessThanOrEqual(2.1)
		}
	)
})
