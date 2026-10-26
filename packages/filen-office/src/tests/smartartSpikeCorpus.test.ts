import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CORPUS_DIR } from "./corpusDir"
import { scoreFile, type DiagramScore } from "./smartartIoU"

// Our layout of every corpus diagram that ships PowerPoint's own cache, scored per shape by IoU
// against the cached box (smartartIoU.ts).

const fetched = existsSync(CORPUS_DIR)
const FAMILIES = ["pptx", "potx", "pptm", "ppsx", "ppsm", "potm"]

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1

	return sorted.length === 0
		? 0
		: sorted.length % 2 === 1
			? (sorted[mid] as number)
			: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

function corpusFiles(): string[] {
	if (!fetched) return []

	const out: string[] = []

	for (const family of FAMILIES) {
		const dir = join(CORPUS_DIR, family)

		if (!existsSync(dir)) continue

		for (const name of readdirSync(dir).sort()) out.push(`${family}/${name}`)
	}

	return out
}

// The layouts the spike was sized on; the rest of the cached corpus is measured for breadth.
const NAMED = new Set(["vProcess5", "default", "hList1"])

describe.skipIf(!fetched)("SmartArt layout against PowerPoint's cached drawings", () => {
	it("lays out the named layouts with a median IoU of at least 0.85", { timeout: 120_000 }, async () => {
		const scores: DiagramScore[] = []

		for (const file of corpusFiles()) {
			const bytes = readFileSync(join(CORPUS_DIR, file))

			if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) continue

			scores.push(...(await scoreFile(join(CORPUS_DIR, file), file)))
		}

		const named = scores.filter(s => NAMED.has(s.layout))
		const report = process.env["SMARTART_SPIKE_REPORT"]

		if (report !== undefined && report !== "") writeFileSync(report, JSON.stringify(scores, null, "\t"))

		expect(named.every(s => s.error === undefined)).toBe(true)
		expect(median(named.map(s => s.mean))).toBeGreaterThanOrEqual(0.85)
	})
})
