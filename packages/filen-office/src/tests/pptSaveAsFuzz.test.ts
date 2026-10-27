import { describe, expect, it } from "vitest"
import { CfbFile, cfbBytes } from "../core/cfb/index"
import { bytesSource, type ByteSink } from "../core/opc/index"
import { pptToPptx } from "../core/ppt/toPptx"
import { openPptxPackage } from "../core/pptx/package"
import { PresentationError } from "../core/presentation/model"
import { pptSaveAs } from "../dom/presentation/engine/convert"
import { RICH_BUILD, RICH_TAG, RICH_TRANSITION, richDeck } from "./pptFixtures"
import { cpuMs } from "./timing"

// Damaged decks holding every reader past the slides (time tree, comment, transition sound, Office 97 build, linked
// movie, embedded object storage, sound collection), through conversion, the pptx reader and Save as: each answers with
// a saved copy or a typed refusal, never an untyped error, and each round stays cheap.

// A small deterministic generator (xorshift32), so a failure reproduces from its seed.
function random(seed: number): () => number {
	let state = seed >>> 0 || 1

	return () => {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5

		return (state >>> 0) / 0x100000000
	}
}

async function streams(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
	const cfb = await CfbFile.open(bytesSource(bytes))
	const out = new Map<string, Uint8Array>()

	for (const entry of cfb.walk())
		if (entry.kind === "stream" && entry.path.length === 1) out.set(entry.name, (await cfb.read(entry)).slice())

	return out
}

// Where `needle` starts in `hay`, by its first 24 bytes; -1 when absent.
function indexOf(hay: Uint8Array, needle: Uint8Array): number {
	const length = Math.min(needle.length, 24)

	outer: for (let at = 0; at + needle.length <= hay.length; at++) {
		for (let k = 0; k < length; k++) if (hay[at + k] !== needle[k]) continue outer

		return at
	}

	return -1
}

const nullSink = (): ByteSink => ({ write: () => Promise.resolve(), close: () => Promise.resolve() })

async function outcome(bytes: Uint8Array): Promise<string> {
	const converted = await pptToPptx(bytesSource(bytes))

	if (converted.kind === "refused") return converted.reason

	const opened = await openPptxPackage(converted.pptx)

	if (opened.kind === "refused") return `pptx:${opened.reason}`

	await opened.parts.parseAll()

	try {
		await pptSaveAs(converted.pptx, undefined, nullSink())
	} catch (error) {
		if (error instanceof PresentationError) return `save:${error.reason}`

		throw error
	}

	return "saved"
}

describe("ppt Save as fuzz", () => {
	it("answers damaged rich decks with a saved copy or a typed refusal", { timeout: 300_000 }, async () => {
		const base = (await richDeck()).bytes

		expect(await outcome(base)).toBe("saved")

		const parts = await streams(base)
		const document = parts.get("PowerPoint Document") ?? new Uint8Array(0)
		// Most rounds damage one of the new readers' records; the rest anywhere.
		const regions = [RICH_TAG, RICH_TRANSITION, RICH_BUILD].map(region => ({ at: indexOf(document, region), length: region.length }))

		expect(regions.every(region => region.at >= 0)).toBe(true)

		const seen = new Map<string, number>()
		let worst = 0

		for (const seed of [11, 12, 13, 14]) {
			const next = random(seed * 7919)

			for (let round = 0; round < 300; round++) {
				const stream = document.slice()
				const region = next() < 0.7 ? regions[Math.floor(next() * regions.length)] : undefined
				const from = region?.at ?? 0
				const span = region?.length ?? stream.length
				const flips = 1 + Math.floor(next() * 8)

				for (let k = 0; k < flips; k++) stream[from + Math.floor(next() * span)] = Math.floor(next() * 256)

				const mutated = new Map(parts)

				mutated.set("PowerPoint Document", next() < 0.15 ? stream.subarray(0, Math.floor(next() * stream.length)) : stream)

				const start = cpuMs()
				let result: string

				try {
					result = await outcome(await cfbBytes([...mutated].map(([name, bytes]) => ({ path: [name], bytes }))))
				} catch (error) {
					throw new Error(
						`seed ${String(seed)} round ${String(round)}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
						{ cause: error }
					)
				}

				worst = Math.max(worst, cpuMs() - start)
				seen.set(result, (seen.get(result) ?? 0) + 1)
			}
		}

		expect([...seen.keys()].every(key => key === "saved" || !key.includes(" "))).toBe(true)
		expect(seen.get("saved") ?? 0).toBeGreaterThan(600)
		expect(worst).toBeLessThan(250)
	})
})
