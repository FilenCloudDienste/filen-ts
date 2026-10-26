import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { CfbFile, cfbBytes } from "../core/cfb/index"
import { pptToPptx } from "../core/ppt/toPptx"
import { openPptxPackage } from "../core/pptx/package"
import { CORPUS_DIR } from "./corpusDir"
import { buildPpt, FIXTURE_PNG } from "./pptFixtures"

// Hostile .ppt input: the PowerPoint Document stream of a synthetic deck (and of a corpus deck when present) with
// bytes flipped and cut, decrypted or not. Every outcome is a converted deck the pptx reader opens and parses, or a
// typed refusal; nothing throws.

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

async function rebuilt(parts: ReadonlyMap<string, Uint8Array>): Promise<Uint8Array> {
	return cfbBytes([...parts].map(([name, bytes]) => ({ path: [name], bytes })))
}

const decryption = {
	password: "secret",
	sha1: (data: Uint8Array): Promise<Uint8Array> => Promise.resolve(new Uint8Array(createHash("sha1").update(data).digest()))
}

async function outcome(bytes: Uint8Array, password: boolean): Promise<string> {
	const converted = await pptToPptx(bytesSource(bytes), password ? { decryption } : {})

	if (converted.kind === "refused") return converted.reason

	const opened = await openPptxPackage(converted.pptx)

	if (opened.kind === "refused") return `pptx:${opened.reason}`

	await opened.parts.parseAll()

	for (const entry of converted.pptx.entries())
		if (entry.name.startsWith("ppt/media/")) await converted.pptx.read(entry.name).catch(() => undefined)

	return "converted"
}

async function fuzz(base: Uint8Array, rounds: number, seed: number, password: boolean): Promise<Map<string, number>> {
	const parts = await streams(base)
	const document = parts.get("PowerPoint Document") ?? new Uint8Array(0)
	const next = random(seed)
	const seen = new Map<string, number>()

	for (let round = 0; round < rounds; round++) {
		const stream = document.slice()
		const flips = 1 + Math.floor(next() * 8)

		for (let k = 0; k < flips; k++) stream[Math.floor(next() * stream.length)] = Math.floor(next() * 256)

		const cut = next() < 0.2 ? stream.subarray(0, Math.floor(next() * stream.length)) : stream
		const mutated = new Map(parts)

		mutated.set("PowerPoint Document", cut)

		let result: string

		try {
			result = await outcome(await rebuilt(mutated), password)
		} catch (error) {
			throw new Error(
				`seed ${String(seed)} round ${String(round)}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
				{ cause: error }
			)
		}

		seen.set(result, (seen.get(result) ?? 0) + 1)
	}

	return seen
}

const DECK = {
	slides: [
		{
			shapes: [
				{ text: "Title", textType: 0, placeholder: { type: 13, position: 0 }, anchor: [100, 300, 5400, 700] as const },
				{ text: "Body text\rSecond", textType: 1, placeholder: { type: 14, position: 1 }, anchor: [900, 300, 5400, 4000] as const },
				{ picture: true, anchor: [100, 100, 1000, 1000] as const }
			]
		},
		{
			hidden: true,
			shapes: [{ outline: 0, placeholder: { type: 14, position: 1 }, anchor: [900, 300, 5400, 4000] as const }],
			outline: [{ type: 1, text: "Outline" }]
		}
	],
	png: FIXTURE_PNG
}

describe("ppt fuzz", () => {
	it("answers a damaged plain deck with a deck or a typed refusal", { timeout: 120_000 }, async () => {
		const seen = await fuzz((await buildPpt(DECK)).bytes, 400, 0x5eed, false)

		expect([...seen.keys()].every(key => key === "converted" || !key.includes(" "))).toBe(true)
		expect(seen.get("converted") ?? 0).toBeGreaterThan(0)
	})

	it("answers a damaged encrypted deck with a deck or a typed refusal", { timeout: 120_000 }, async () => {
		const seen = await fuzz((await buildPpt({ ...DECK, password: "secret" })).bytes, 300, 0xc0ffee, true)

		expect(seen.size).toBeGreaterThan(1)
	})

	it.skipIf(!existsSync(join(CORPUS_DIR, "ppt/poi__bug45124.ppt")))(
		"answers a damaged corpus deck with a deck or a typed refusal",
		{ timeout: 120_000 },
		async () => {
			const seen = await fuzz(new Uint8Array(readFileSync(join(CORPUS_DIR, "ppt/poi__bug45124.ppt"))), 200, 0xbeef, false)

			expect(seen.get("converted") ?? 0).toBeGreaterThan(0)
		}
	)
})
