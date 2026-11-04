import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DocxEditorSession } from "@filen/office/core/docx/edit"
import { prepareDocxSave, saveDocx, writerProof, zipDocxSave } from "@filen/office/core/docx/write"
import { CORPUS_DIR } from "./corpusDir"
import { openBytes } from "./docxEditFixtures"
import { runEditScript } from "./docxWriteFixtures"
import { buildDocx } from "./docxSynthetic"

const FIXTURE = join(import.meta.dirname, "fixtures", "08-large-300p.docx")
const TARIFF = join(CORPUS_DIR, "docx", "govuk__Tariff_of_the_United_Kingdom_v1.34.docx")

async function measure(path: string): Promise<string> {
	const opened = await openBytes(new Uint8Array(readFileSync(path)))
	let start = performance.now()
	const session = new DocxEditorSession(opened.context, { proof: null })
	const build = performance.now() - start

	start = performance.now()
	session.prove(writerProof(opened.context))

	const proof = performance.now() - start
	const unedited = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })
	const script = runEditScript(opened)
	const peak = process.resourceUsage().maxRSS
	const edited = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [script.session] })
	const grown = (process.resourceUsage().maxRSS - peak) / 1024

	expect(unedited.changedParts).toEqual([])

	const t = edited.timings

	return (
		`build ${build.toFixed(0)} ms, gate 1 ${proof.toFixed(0)} ms; unedited save ${(unedited.timings.serializeMs + unedited.timings.zipMs).toFixed(0)} ms; ` +
		`edited (${script.done.join("+")}) serialise ${t.serializeMs} ms, gate 2 parts ${t.verifyPartsMs} ms, zip ${t.zipMs} ms, ` +
		`gate 2 zip ${t.verifyZipMs} ms, peak RSS +${grown.toFixed(0)} MB`
	)
}

// Stretches are measured in this thread's CPU time where the runtime can tell it (reported, not asserted:
// GC and JIT make any time on a shared machine noisy); the assertions are structural.
function busy(): number {
	const usage: unknown = Reflect.get(process, "threadCpuUsage")

	if (typeof usage !== "function") return performance.now()

	const { user, system } = Reflect.apply(usage, process, []) as { user: number; system: number }

	return (user + system) / 1000
}

// A save in slices, as the page runs it: the writer and the part checks give the host a turn every 12 ms;
// the longest stretch between two turns is what a user could feel.
async function sliced(path: string): Promise<{ report: string }> {
	const opened = await openBytes(new Uint8Array(readFileSync(path)))
	const script = runEditScript(opened)
	const input = { pkg: opened.pkg, context: opened.context, sessions: [script.session] }
	const stretches: number[] = []
	let last = busy()
	const slicing = {
		sliceMs: 12,
		now: () => performance.now(),
		pause: () => {
			stretches.push(busy() - last)

			return new Promise<void>(resolve =>
				setImmediate(() => {
					last = busy()
					resolve()
				})
			)
		}
	}
	const rounds: string[] = []

	// The first save also reads what later saves reuse (the source's facts and first blocks).
	for (const round of ["first", "next"]) {
		stretches.length = 0
		last = busy()

		const prepared = await prepareDocxSave(input, { slicing })

		stretches.push(busy() - last)

		const zipped = await zipDocxSave(opened.pkg.opc, prepared)
		const max = Math.max(...stretches)

		rounds.push(
			`${round}: serialise ${prepared.serializeMs} ms + gate 2 parts ${prepared.verifyPartsMs} ms in ${stretches.length} slices ` +
				`(longest ${max.toFixed(0)} ms), zip + gate 2 zip ${zipped.zipMs + zipped.verifyZipMs} ms`
		)
	}

	return { report: rounds.join("; ") }
}

// How often a save can give the host a turn: with a slice budget of 0 every point that checks the clock
// pauses, so the count is the number of yield points the save went through (machine-independent).
async function yieldPoints(path: string): Promise<{ points: number; blocks: number }> {
	const opened = await openBytes(new Uint8Array(readFileSync(path)))
	const script = runEditScript(opened)
	let points = 0

	await prepareDocxSave(
		{ pkg: opened.pkg, context: opened.context, sessions: [script.session] },
		{
			slicing: {
				sliceMs: 0,
				now: () => performance.now(),
				pause: () => {
					points++

					return Promise.resolve()
				}
			}
		}
	)

	return { points, blocks: script.session.state.doc.childCount }
}

describe("docx writer performance", () => {
	it("yields at every top-level block while writing and checking the 300-page fixture", { timeout: 120_000 }, async () => {
		const { report } = await sliced(FIXTURE)

		console.log(`300p sliced: ${report}`)

		const { points, blocks } = await yieldPoints(FIXTURE)

		console.log(`300p: ${points} yield points for ${blocks} top-level blocks`)

		// The writer (owners, copies, write) and gate 2 (paragraph checks) each pass every top-level block
		// at a yield point; none of their steps is longer than one block.
		expect(points).toBeGreaterThanOrEqual(blocks * 3)
	})

	it.skipIf(!existsSync(TARIFF))("saves the Tariff document in short slices", { timeout: 600_000 }, async () => {
		const { report } = await sliced(TARIFF)

		console.log(`Tariff sliced: ${report}`)
	})

	it("proves and saves the 300-page fixture", { timeout: 120_000 }, async () => {
		console.log(`300p: ${await measure(FIXTURE)}`)
	})

	it.skipIf(!existsSync(TARIFF))("proves and saves the Tariff document", { timeout: 600_000 }, async () => {
		console.log(`Tariff: ${await measure(TARIFF)}`)
	})
})

describe("docx writer performance: people", () => {
	const PARAGRAPH =
		'<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">The quick brown fox jumps over the lazy dog and a cat and a rat.</w:t></w:r></w:p>'
	const REVISION = '<w:p><w:ins w:id="9" w:author="Bo" w:date="2020-01-03T00:00:00Z"><w:r><w:t>Added</w:t></w:r></w:ins></w:p>'
	const people = (author: string): string =>
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">' +
		`<w15:person w15:author="${author}"/></w15:people>`

	// How many times each save reads a source part's bytes for authors: the author scan is the only reader of the
	// bytes that looks for an "a" (author=). Counted, not timed: a scan of the whole file is the cost in question,
	// and a count is the same on any machine.
	async function authorScans(people: string): Promise<number[]> {
		const opened = await openBytes(buildDocx({ body: REVISION + PARAGRAPH.repeat(2_000), people }))
		const session = new DocxEditorSession(opened.context)
		const sources = new Set<Uint8Array>(opened.context.model.parts.map(part => part.document.bytes))
		const indexOf = Uint8Array.prototype.indexOf
		const scans: number[] = []
		let reads = 0

		Object.defineProperty(Uint8Array.prototype, "indexOf", {
			configurable: true,
			writable: true,
			value: function (this: Uint8Array, value: number, from?: number): number {
				if (value === 0x61 && sources.has(this)) reads++

				return indexOf.call(this, value, from)
			}
		})

		try {
			for (let k = 0; k < 4; k++) {
				session.dispatch(session.state.tr.insertText("x", 1))
				reads = 0
				await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })
				scans.push(reads)
			}
		} finally {
			Reflect.deleteProperty(Uint8Array.prototype, "indexOf")
		}

		return scans
	}

	// The source's authors are read once per document: a person no revision names costs a later save no scan
	// of the whole file.
	it("costs a save no scan of the source for a person nothing names", async () => {
		const [first = 0, ...later] = await authorScans(people("Zed"))

		// The first save reads the source's authors (what the probe sees), the later ones reuse them.
		expect(first).toBeGreaterThan(1000)
		expect(later).toEqual([0, 0, 0])
	})
})
