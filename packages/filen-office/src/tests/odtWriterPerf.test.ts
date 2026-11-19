import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { openOdtSource } from "../core/odt/write/source"
import { proveOdt, writeOdt } from "../core/odt/write/writer"
import { CORPUS_DIR } from "./corpusDir"
import { decodeUtf8, encodeUtf8 } from "@filen/office/core/xml"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import { odtBytes } from "./odtFixtures"
import { editOdt, saveOdt } from "./odtWriteFixtures"
import { paragraphs } from "./rtfWriteFixtures"
import { budget, cpuMs } from "./timing"

// The largest corpus ODT (14 MB, pictures mostly) read, proved and saved where the web runs it (the docx worker):
// CPU time per step, peak memory growth, and the longest stretch the worker goes without a turn when the steps run
// in 12 ms slices (a close must be read within it). Opt-in where the corpus exists.

const FILE = join(CORPUS_DIR, "odt", "govuk__8_Energy_20_5_2026v2.odt")
// Paragraphs proved, and paragraphs put in one list, with their bounds: about three times what they take where pairing
// and list seeding are linear, and well under what they took when quadratic.
const MANY = 60_000
const PROVE_MS = 3000
const LISTED = 10_000
const LIST_MS = 2500

function turns(): {
	turns: { signal: { aborted: boolean }; slicing: { sliceMs: number; now: () => number; pause: () => Promise<void> } }
	longest: () => number
} {
	let last = cpuMs()
	let longest = 0

	return {
		turns: {
			signal: { aborted: false },
			slicing: {
				sliceMs: 12,
				now: () => performance.now(),
				pause: () => {
					longest = Math.max(longest, cpuMs() - last)

					return new Promise<void>(resolve =>
						setImmediate(() => {
							last = cpuMs()
							resolve()
						})
					)
				}
			}
		},
		longest: () => Math.max(longest, cpuMs() - last)
	}
}

describe.skipIf(!existsSync(FILE))("ODT writer on a 14 MB document", () => {
	it("reads, proves and saves within the docx save budgets", { timeout: 600_000 }, async () => {
		const bytes = new Uint8Array(readFileSync(FILE))
		const rss = process.resourceUsage().maxRSS
		let started = cpuMs()
		const opening = turns()
		const opened = await openOdtSource(bytes, opening.turns)
		const openMs = cpuMs() - started

		if (!opened.ok) throw new Error(opened.message)

		const openLongest = opening.longest()

		started = cpuMs()

		const proving = turns()
		const proof = await proveOdt(opened.source, proving.turns)
		const proveMs = cpuMs() - started
		const proveLongest = proving.longest()
		// A typed edit as the docx writer writes it: the body part, its first text grown.
		const body = decodeUtf8(opened.source.translation.parts.get("word/document.xml") as Uint8Array)
		const at = body.indexOf(">", body.indexOf("<w:t ")) + 1
		const edits = { parts: new Map([["word/document.xml", encodeUtf8(`${body.slice(0, at)}Filen ${body.slice(at)}`)]]) }

		started = cpuMs()

		const saving = turns()
		const written = await writeOdt(opened.source, edits, { turns: saving.turns })
		const saveMs = cpuMs() - started
		const saveLongest = saving.longest()
		const grown = (process.resourceUsage().maxRSS - rss) / 1024

		console.log(
			`open ${openMs.toFixed(0)} ms (longest stretch ${openLongest.toFixed(0)} ms), prove ${proveMs.toFixed(0)} ms (${proveLongest.toFixed(0)} ms, ${proof.locked.length} locked), save ${saveMs.toFixed(0)} ms (${saveLongest.toFixed(0)} ms, ${written.written} written, ${written.bytes.length} bytes), peak RSS +${grown.toFixed(0)} MB`
		)

		expect(written.bytes.length).toBeGreaterThan(bytes.length / 2)
		// The docx editor's save budget for a document this size; no task of the save or the proof past 50 ms.
		expect(saveMs).toBeLessThan(budget(5000))
		expect(saveLongest).toBeLessThan(budget(50))
		expect(proveLongest).toBeLessThan(budget(50))
	})
})

async function contentOf(bytes: Uint8Array): Promise<string> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const found = archive.get("content.xml")

	if (found === undefined) throw new Error("no content.xml")

	return decodeUtf8(await archive.read(found))
}

// Work that grows with the document, bounded so that it stays linear: per-name scans of the stream, segments paired
// with the reread blocks one by one, the lists before each paragraph put in a list walked again.
describe("ODT writer on many blocks", () => {
	it("names thousands of tracked changes without a scan of the stream each", { timeout: 120_000 }, async () => {
		let regions = ""
		let body = ""

		for (let k = 0; k < 3000; k++) {
			regions += `<text:changed-region xml:id="c${k}" text:id="c${k}"><text:insertion><office:change-info><dc:creator>Ann</dc:creator><dc:date>2020-01-01T00:00:00</dc:date></office:change-info></text:insertion></text:changed-region>`
			body += `<text:p>One <text:change-start text:change-id="c${k}"/>two<text:change-end text:change-id="c${k}"/> three${'<text:s text:c="2"/>'.repeat(20)}</text:p>`
		}

		const editing = await editOdt(odtBytes({ body: `<text:tracked-changes>${regions}</text:tracked-changes>${body}` }), {
			prove: false
		})
		let started = cpuMs()
		const proof = await proveOdt(editing.source)
		const proveMs = cpuMs() - started

		expect(proof.locked).toHaveLength(0)

		const first = paragraphs(editing.session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		editing.opened.context.identity.author = "Ann"
		editing.opened.context.review.tracking = true
		editing.session.dispatch(editing.session.state.tr.insertText("new ", first.pos + 1))
		started = cpuMs()

		const content = await contentOf((await saveOdt(editing)).bytes)
		const saveMs = cpuMs() - started

		expect(content).toContain(
			'<text:p><text:change-start text:change-id="ctFilen1"/>new <text:change-end text:change-id="ctFilen1"/>One <text:change-start text:change-id="ctFilen2"/>two'
		)
		expect(proveMs).toBeLessThan(budget(3000))
		expect(saveMs).toBeLessThan(budget(3000))
	})

	it("proves tens of thousands of paragraphs without pairing each with every reread block", { timeout: 120_000 }, async () => {
		const editing = await editOdt(odtBytes({ body: "<text:p>Paragraph</text:p>".repeat(MANY) }), { prove: false })
		const started = cpuMs()
		const proof = await proveOdt(editing.source)

		expect(proof.locked).toHaveLength(0)
		expect(cpuMs() - started).toBeLessThan(budget(PROVE_MS))
	})

	it("puts thousands of paragraphs in a list without walking the blocks before each", { timeout: 120_000 }, async () => {
		const editing = await editOdt(odtBytes({ body: "<text:p>Paragraph</text:p>".repeat(LISTED) }), { prove: false })
		const doc = editing.session.state.doc

		editing.session.dispatch(editing.session.state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)))
		expect(await editing.editor.execute({ type: "list.bullet" })).toBe(true)

		const started = cpuMs()
		const content = await contentOf((await saveOdt(editing)).bytes)

		expect(cpuMs() - started).toBeLessThan(budget(LIST_MS))
		expect(content.match(/<text:list-item>/gu)).toHaveLength(LISTED)
	})
})
