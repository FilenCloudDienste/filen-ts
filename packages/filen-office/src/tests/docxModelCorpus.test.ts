import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { buildDocxModel, modelStats, openDocxPackage } from "@filen/office/core/docx"
import { CORPUS_DIR as CORPUS, corpusFiles } from "./corpusDir"
import { modelProblems } from "./docxIntegrity"

// The licensed real-world corpus is kept out of the repository (pnpm run corpus:fetch); this sweep runs only where it exists.
const EXTENSIONS = ["docx", "docm", "dotx", "dotm"]

function percentile(sorted: readonly number[], fraction: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

describe.skipIf(!existsSync(CORPUS))("docx model over the real-world corpus", () => {
	it("opens and models every word-processing file with sound spans", { timeout: 300_000 }, async () => {
		const files = corpusFiles(EXTENSIONS)
		const failures: string[] = []
		const refused = new Map<string, string>()
		const times: { name: string; ms: number; bytes: number }[] = []
		const opaque: Record<string, number> = {}

		for (const file of files) {
			const name = file.slice(CORPUS.length + 1)
			const bytes = new Uint8Array(readFileSync(file))

			try {
				const start = performance.now()
				const opened = await openDocxPackage(bytesSource(bytes))

				if (!opened.ok) {
					refused.set(name, opened.reason)

					continue
				}

				const model = await buildDocxModel(opened.package)

				times.push({ name, ms: performance.now() - start, bytes: bytes.length })

				const problems = modelProblems(model, 3)

				if (problems.length > 0) failures.push(`${name}: ${problems.join("; ")}`)

				for (const [element, count] of Object.entries(modelStats(model).opaque)) opaque[element] = (opaque[element] ?? 0) + count
			} catch (error) {
				failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		const sorted = times.map(time => time.ms).sort((a, b) => a - b)
		const slowest = [...times].sort((a, b) => b.ms - a.ms).slice(0, 5)

		console.log(
			`docx corpus: ${files.length} files, ${times.length} modelled, ${refused.size} refused (${[...refused].map(([name, reason]) => `${name}: ${reason}`).join(", ")}), ` +
				`open+model p50 ${percentile(sorted, 0.5).toFixed(1)} ms, p95 ${percentile(sorted, 0.95).toFixed(1)} ms, max ${(sorted[sorted.length - 1] ?? 0).toFixed(1)} ms\n` +
				`slowest: ${slowest.map(time => `${time.name} ${time.ms.toFixed(0)} ms (${(time.bytes / 1e6).toFixed(1)} MB)`).join(", ")}\n` +
				`opaque elements: ${JSON.stringify(opaque)}`
		)

		expect(failures).toEqual([])
		expect([...refused.values()].every(reason => reason === "encrypted")).toBe(true)
		expect(times.length + refused.size).toBe(files.length)
	})
})
