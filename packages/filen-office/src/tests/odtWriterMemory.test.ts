import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openOdtSource, type OdtSource } from "../core/odt/write/source"
import { writeOdt, type OdtEdits } from "../core/odt/write/writer"
import { CORPUS_DIR } from "./corpusDir"
import { decodeUtf8, encodeUtf8 } from "@filen/office/core/xml"
import { liveHeap, liveHeapNow } from "./liveHeap"
import { cpuMs } from "./timing"

// What a save of the largest corpus ODT (2.4 MB content.xml, 14 MB with its pictures) holds at its peak, over what
// the open document holds: heap and array buffers live at every turn the sliced save gives (collected first), for
// an edit the whole file's proof proves and one the span proof does (liveHeap.ts: this process's live heap, whatever
// runs alongside). Needs the corpus.

const FILE = join(CORPUS_DIR, "odt", "govuk__8_Energy_20_5_2026v2.odt")
const MB = 1024 * 1024

function slicing(pause: () => void): {
	signal: { aborted: boolean }
	slicing: { sliceMs: number; now: () => number; pause: () => Promise<void> }
} {
	return {
		signal: { aborted: false },
		slicing: {
			sliceMs: 12,
			now: () => performance.now(),
			pause: () => {
				pause()

				return new Promise<void>(resolve => setImmediate(resolve))
			}
		}
	}
}

// The save's peak over what was live before it, and its CPU time (measured apart: collecting at every turn costs).
async function measured(source: OdtSource, edits: OdtEdits): Promise<{ peak: number; ms: number; proof: string; size: number }> {
	const base = await liveHeap()
	let peak = base
	const written = await writeOdt(source, edits, { turns: slicing(() => (peak = Math.max(peak, liveHeapNow()))) })
	let ms = Infinity

	for (let run = 0; run < 3; run++) {
		const started = cpuMs()

		await writeOdt(source, edits, { turns: slicing(() => undefined) })
		ms = Math.min(ms, cpuMs() - started)
	}

	return { peak: Math.max(peak, await liveHeap()) - base, ms, proof: written.proof ?? "none", size: written.bytes.length }
}

// The translation's body with "Filen " typed at the first text of the first paragraph `which` takes.
function typed(source: OdtSource, which: (paragraph: string) => boolean): OdtEdits {
	const body = decodeUtf8(source.translation.parts.get("word/document.xml") as Uint8Array)
	const paragraph = [...body.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/gu)].find(match => /<w:t[ >]/u.test(match[0]) && which(match[0]))
	const text = (paragraph?.index ?? 0) + (/<w:t[ >]/u.exec(paragraph?.[0] ?? "")?.index ?? 0)
	const at = body.indexOf(">", text) + 1

	return { parts: new Map([["word/document.xml", encodeUtf8(`${body.slice(0, at)}Filen ${body.slice(at)}`)]]) }
}

describe.skipIf(!existsSync(FILE))("ODT writer memory on a 14 MB document", () => {
	it("saves an edit within a few times its content's size", { timeout: 600_000 }, async () => {
		const opened = await openOdtSource(new Uint8Array(readFileSync(FILE)))

		if (!opened.ok) throw new Error(opened.message)

		const source = opened.source
		const content = source.archive.get("content.xml")?.uncompressedSize ?? 1
		// The first text (a paragraph holding pictures and bookmarks: the whole file's proof), and a plain paragraph's.
		const first = await measured(
			source,
			typed(source, () => true)
		)
		const plain = await measured(
			source,
			typed(source, paragraph => !/drawing|bookmark|numPr|hyperlink|footnote|sectPr|txbx|fldChar/u.test(paragraph))
		)

		for (const [name, save] of [
			["first text", first],
			["plain paragraph", plain]
		] as const) {
			console.log(
				`${name}: content.xml ${(content / MB).toFixed(1)} MB, file ${(save.size / MB).toFixed(1)} MB; peak +${(save.peak / MB).toFixed(1)} MB (${((save.peak - save.size) / content).toFixed(1)}x content.xml past the file), ${save.ms.toFixed(0)} ms CPU, ${save.proof} proof`
			)
		}

		expect(first.proof).toBe("whole")
		expect(plain.proof).toBe("span")
		// Past the written file (what the save returns): a few times content.xml.
		expect(plain.peak - plain.size).toBeLessThan(6 * content)
		expect(first.peak - first.size).toBeLessThan(9 * content)
	})
})
