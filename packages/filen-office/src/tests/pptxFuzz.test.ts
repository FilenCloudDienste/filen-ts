import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openPptx } from "../core/pptx/package"
import { resolveParagraph, resolveShape } from "../core/presentation/inherit"
import { PresentationError, type ShapeNode } from "../core/presentation/model"
import type { CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"

// Damaged decks: truncated and bit-flipped copies of corpus files either open (and every slide parses and
// resolves) or are refused with a typed reason; nothing else escapes the reader.

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "corpus", "manifest.json"), "utf8")) as CorpusManifest
// The 20 smallest unencrypted OOXML decks, so the run stays short.
const SAMPLES = manifest.files
	.filter(file => /^(pptx|pptm|potx|potm|ppsx|ppsm)\//u.test(file.path) && file.password === undefined)
	.filter(file => existsSync(join(CORPUS_DIR, file.path)))
	.sort((a, b) => a.size - b.size)
	.slice(0, 20)

function random(seed: number): () => number {
	let state = seed >>> 0 || 1

	return () => {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5

		return (state >>> 0) / 0x100000000
	}
}

function walk(shapes: readonly ShapeNode[], visit: (shape: ShapeNode) => void): void {
	for (const shape of shapes) {
		visit(shape)
		walk(shape.children ?? [], visit)
	}
}

// "opened", or the refusal's reason; throws anything that is not a typed refusal.
async function outcome(bytes: Uint8Array): Promise<string> {
	const open = await openPptx(bytesSource(bytes))

	if (open.kind === "refused") return open.reason

	try {
		await open.parts.parseAll()
	} catch (error) {
		if (error instanceof PresentationError) return error.reason

		throw error
	}

	for (const ref of open.deck.slides) {
		const slide = open.deck.nodes.get(ref)

		walk(slide?.shapes ?? [], shape => {
			const resolved = resolveShape(open.deck, ref, shape)

			for (const paragraph of shape.text?.paragraphs ?? []) resolveParagraph(resolved, paragraph)
		})
	}

	return "opened"
}

describe.skipIf(SAMPLES.length === 0)("damaged pptx", () => {
	it("refuses truncated copies typed", { timeout: 120_000 }, async () => {
		const seen = new Map<string, number>()

		for (const [index, file] of SAMPLES.entries()) {
			const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, file.path)))
			const next = random(index + 1)

			for (let cut = 0; cut < 5; cut++) {
				const result = await outcome(bytes.subarray(0, Math.floor(next() * bytes.length)))

				seen.set(result, (seen.get(result) ?? 0) + 1)
			}
		}

		expect([...seen.keys()].every(reason => ["opened", "malformed", "tooLarge", "unsupported", "encrypted"].includes(reason))).toBe(
			true
		)
		expect(seen.get("malformed")).toBeGreaterThan(0)
	})

	it("refuses or opens bit-flipped copies, typed", { timeout: 120_000 }, async () => {
		const seen = new Map<string, number>()

		for (const [index, file] of SAMPLES.entries()) {
			const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, file.path)))
			const next = random(1000 + index)

			for (let round = 0; round < 10; round++) {
				const copy = bytes.slice()

				for (let flip = 0; flip < 8; flip++) {
					const at = Math.floor(next() * copy.length)

					copy[at] = (copy[at] ?? 0) ^ (1 << Math.floor(next() * 8))
				}

				const result = await outcome(copy)

				seen.set(result, (seen.get(result) ?? 0) + 1)
			}
		}

		expect(
			[...seen.keys()].every(reason =>
				["opened", "malformed", "tooLarge", "tooDeep", "unsupported", "unsupportedEncryption"].includes(reason)
			)
		).toBe(true)
		expect([...seen.values()].reduce((sum, count) => sum + count, 0)).toBe(SAMPLES.length * 10)
	})
})
