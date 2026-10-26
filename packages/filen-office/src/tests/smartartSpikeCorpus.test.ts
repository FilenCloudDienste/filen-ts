import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { themeOf } from "../core/presentation/theme"
import { smartArtFontRequests, textAdapterMeasurer } from "../core/smartart/measure"
import { CORPUS_DIR } from "./corpusDir"
import { fontsFor, openDeck } from "./presentationTextHarness"
import { scoreFile, type DiagramScore, type MeasurerFor } from "./smartartIoU"

// Our layout of every corpus diagram that ships PowerPoint's own cache, scored per shape by IoU against the cached
// box (smartartIoU.ts), with text measured by the slide text adapter on the bundled OFL faces.

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

// The slide's theme fonts through the presentation text adapter.
async function adapterMeasurers(path: string): Promise<MeasurerFor | undefined> {
	const opened = await openDeck(path).catch(() => undefined)

	if (opened === undefined) return undefined

	return async (slide, texts) => {
		const deck = opened.deck
		const node = [...deck.nodes.values()].find(n => n.part === `/${slide}` || n.part === slide)

		if (node === undefined) throw new Error(`${path}: no slide ${slide}`)

		const theme = themeOf(deck.nodes, node)
		const fonts = fontsFor(deck, node, theme === undefined ? undefined : opened.theme(theme.part))

		await opened.fonts.prepare(smartArtFontRequests(texts, fonts))

		return textAdapterMeasurer(opened.environment, fonts)
	}
}

// The layouts the engine was first sized on; the rest of the cached corpus is measured for breadth.
const NAMED = new Set(["vProcess5", "default", "hList1"])

describe.skipIf(!fetched)("SmartArt layout against PowerPoint's cached drawings", () => {
	it("lays out the named layouts with a median IoU of at least 0.85", { timeout: 300_000 }, async () => {
		const scores: DiagramScore[] = []

		for (const file of corpusFiles()) {
			const path = join(CORPUS_DIR, file)
			const bytes = readFileSync(path)

			if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) continue

			const text = await adapterMeasurers(path)

			scores.push(...(await scoreFile(path, file, undefined, text)))
		}

		const named = scores.filter(s => NAMED.has(s.layout))
		const report = process.env["SMARTART_SPIKE_REPORT"]

		if (report !== undefined && report !== "") writeFileSync(report, JSON.stringify(scores, null, "\t"))

		expect(named.every(s => s.error === undefined)).toBe(true)
		expect(median(named.map(s => s.mean))).toBeGreaterThanOrEqual(0.85)

		// The user's custom scales and offsets: vProcess5's whole-diagram shift and bProcess3's snake re-flow
		// (connector routes aside, which the conn algorithm draws).
		for (const score of scores.filter(s => s.layout === "vProcess5")) expect(score.mean, score.file).toBeGreaterThanOrEqual(0.99)

		for (const score of scores.filter(s => s.layout === "bProcess3")) {
			for (const shape of score.shapes.filter(s => s.name === "node")) expect(shape.iou, score.file).toBeGreaterThanOrEqual(0.95)
		}
	})
})
