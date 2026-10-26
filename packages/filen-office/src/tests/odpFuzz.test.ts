import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openOdp } from "../core/odp/read/document"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { resolveParagraph, resolveShape } from "../core/presentation/inherit"
import { PresentationError, type ShapeNode } from "../core/presentation/model"
import type { CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes, page } from "./odpFixtures"

// Damaged and hostile ODP: truncated and bit-flipped copies of corpus files, markup with garbage values, and decks
// past the budgets either open (and every page parses and resolves) or are refused with a typed reason; nothing else
// escapes the reader.

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "corpus", "manifest.json"), "utf8")) as CorpusManifest
const SAMPLES = manifest.files
	.filter(file => /^(odp|otp)\//u.test(file.path))
	.filter(file => existsSync(join(CORPUS_DIR, file.path)))
	.sort((a, b) => a.size - b.size)
	.slice(0, 16)

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

async function outcome(bytes: Uint8Array, budgets = DEFAULT_PRESENTATION_BUDGETS): Promise<string> {
	const open = await openOdp(bytesSource(bytes), { budgets })

	if (open.kind === "refused") return open.reason

	try {
		await open.parts.parseAll()
	} catch (error) {
		if (error instanceof PresentationError) return error.reason

		throw error
	}

	for (const ref of open.deck.slides) {
		walk(open.deck.nodes.get(ref)?.shapes ?? [], shape => {
			const resolved = resolveShape(open.deck, ref, shape)

			for (const paragraph of shape.text?.paragraphs ?? []) resolveParagraph(resolved, paragraph)
		})
	}

	return "opened"
}

const GARBAGE = ["", "-1", "NaN", "1e999", "-9999999cm", "abc", "?f99", "rotate (x) translate (y)", "#zzzzzz", "100%%", "&#0;"]

describe("damaged ODP", () => {
	it.skipIf(SAMPLES.length === 0)("refuses truncated and bit-flipped copies typed", { timeout: 300_000 }, async () => {
		const seen = new Map<string, number>()

		for (const [index, file] of SAMPLES.entries()) {
			const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, file.path)))
			const next = random(index + 1)

			for (let trial = 0; trial < 6; trial++) {
				const copy = trial < 3 ? bytes.slice(0, Math.floor(next() * bytes.length)) : bytes.slice()

				if (trial >= 3) {
					for (let flip = 0; flip < 8; flip++) {
						const at = Math.floor(next() * copy.length)

						copy[at] = (copy[at] ?? 0) ^ (1 << Math.floor(next() * 8))
					}
				}

				const result = await outcome(copy)

				seen.set(result, (seen.get(result) ?? 0) + 1)
			}
		}

		expect(
			[...seen.keys()].every(reason => ["opened", "malformed", "tooLarge", "unsupported", "tooDeep", "encrypted"].includes(reason))
		).toBe(true)
		expect(seen.get("malformed")).toBeGreaterThan(0)
	})

	it("opens markup with garbage lengths, angles, colours, formulas and transforms", { timeout: 60_000 }, async () => {
		const next = random(7)
		const pick = (): string => GARBAGE[Math.floor(next() * GARBAGE.length)] ?? ""

		for (let trial = 0; trial < 60; trial++) {
			const body = page(
				`<draw:custom-shape svg:x="${pick()}" svg:y="${pick()}" svg:width="${pick()}" svg:height="${pick()}" draw:transform="${pick()}"><draw:enhanced-geometry svg:viewBox="${pick()}" draw:modifiers="${pick()}" draw:text-areas="${pick()} 0 ${pick()} 0" draw:enhanced-path="M ${pick()} 0 L 21600 ${pick()} A ${pick()} Z N"><draw:equation draw:name="f0" draw:formula="${pick()}"/></draw:enhanced-geometry><text:p><text:s text:c="${pick()}"/>x</text:p></draw:custom-shape>` +
					`<draw:frame svg:width="${pick()}" svg:height="1cm"><table:table><table:table-column table:number-columns-repeated="${pick()}"/><table:table-row><table:table-cell table:number-columns-spanned="${pick()}" table:number-rows-spanned="${pick()}"/></table:table-row></table:table></draw:frame>` +
					`<draw:polygon svg:viewBox="${pick()}" draw:points="${pick()},${pick()} 1,2" svg:width="1cm" svg:height="1cm"/>`
			)
			const automatic = `<style:style style:name="g" style:family="graphic"><style:graphic-properties draw:fill="gradient" draw:fill-gradient-name="G" draw:opacity="${pick()}" svg:stroke-width="${pick()}"/></style:style>`
			const styles = `<draw:gradient draw:name="G" draw:style="${pick()}" draw:angle="${pick()}" draw:start-color="${pick()}" draw:border="${pick()}"/>`

			expect(await outcome(odpBytes({ body, automatic, styles })), String(trial)).toMatch(/^(opened|malformed)$/u)
		}
	})

	it("refuses shapes, nesting and runs past their budgets", async () => {
		const shapes = page('<draw:rect svg:width="1cm" svg:height="1cm"/>'.repeat(30))
		const groups = page(`${"<draw:g>".repeat(140)}<draw:rect/>${"</draw:g>".repeat(140)}`)
		const runs = page(
			`<draw:frame><draw:text-box><text:p>${"<text:span>a</text:span><text:line-break/>".repeat(50)}</text:p></draw:text-box></draw:frame>`
		)
		const small = { ...DEFAULT_PRESENTATION_BUDGETS, shapesPerSlide: 20, runsPerBody: 40, runsPerSlide: 1000 }

		expect(await outcome(odpBytes({ body: shapes }), small)).toBe("tooLarge")
		expect(await outcome(odpBytes({ body: groups }))).toBe("tooDeep")
		expect(await outcome(odpBytes({ body: runs }), small)).toBe("tooLarge")
	})
})
