import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { RtfWriteRefusal } from "../core/rtf/write/out"
import { openRtfSource, proveRtf, writeRtf, type RtfSource } from "../core/rtf/write/writer"
import { CORPUS_DIR } from "./corpusDir"
import { editRtf, editsOf, saveRtf, scriptedEdits } from "./rtfWriteFixtures"

// The RTF writer over the corpus's rtf/ files: an untouched save gives the file byte for byte, Gate 1 proves
// (or locks) every block, and the scripted edits save to a file that reads back as edited (the writer's own
// proof) or are refused with a reason. FILEN_OFFICE_RTF_WRITE_OUT names a directory for the report and the
// written files (for the LibreOffice and validator oracles). Opt-in where the corpus exists.

const DIRECTORY = join(CORPUS_DIR, "rtf")
const OUT = process.env["FILEN_OFFICE_RTF_WRITE_OUT"] || undefined

interface Row {
	name: string
	untouched: boolean
	blocks: number
	locked: number
	lockReasons: Record<string, number>
	proveMs: number
	edits: string[]
	saved: boolean
	refusal?: string
	rounds?: number
	written?: number
	saveMs?: number
}

describe.skipIf(!existsSync(DIRECTORY))("RTF writer over the corpus", () => {
	it("saves untouched files byte for byte and scripted edits as edited", { timeout: 1_800_000 }, async () => {
		const rows: Row[] = []

		for (const name of readdirSync(DIRECTORY)
			.filter(file => file.toLowerCase().endsWith(".rtf"))
			.sort()) {
			const bytes = new Uint8Array(readFileSync(join(DIRECTORY, name)))
			let started = performance.now()
			const proof = await proveRtf((await openRtfSource(bytes)) as RtfSource)
			const proveMs = performance.now() - started
			const editing = await editRtf(bytes)
			const untouched = await writeRtf(editing.source, await editsOf(editing))
			const lockReasons: Record<string, number> = {}

			for (const locked of proof.locked) lockReasons[locked.reason] = (lockReasons[locked.reason] ?? 0) + 1

			const row: Row = {
				name,
				untouched: untouched.bytes.length === bytes.length && untouched.bytes.every((byte, k) => byte === bytes[k]),
				blocks: editing.source.read.containers.reduce((sum, container) => sum + container.blocks.length, 0),
				locked: proof.locked.length,
				lockReasons,
				proveMs: Math.round(proveMs),
				edits: await scriptedEdits(editing),
				saved: false
			}

			started = performance.now()

			try {
				const written = await saveRtf(editing)

				row.saved = true
				row.rounds = written.rounds
				row.written = written.written
				if (OUT !== undefined) writeFileSync(join(OUT, name), written.bytes)
			} catch (error) {
				if (!(error instanceof RtfWriteRefusal)) throw error

				row.refusal = error.message.slice(0, 600)
			}

			row.saveMs = Math.round(performance.now() - started)
			rows.push(row)
		}

		if (OUT !== undefined) writeFileSync(join(OUT, "report.json"), JSON.stringify(rows, null, "\t"))

		expect(rows.length).toBeGreaterThan(0)
		expect(rows.filter(row => !row.untouched).map(row => row.name)).toEqual([])

		// A refusal is a legitimate outcome per file, and a file without a paragraph scriptedEdits can edit applies
		// none, so the floors bound the whole run (measured: 85 of 114 files edited, 81 of those saved).
		const edited = rows.filter(row => row.edits.length > 0)

		expect(edited.length).toBeGreaterThanOrEqual(75)
		expect(edited.filter(row => row.saved).length).toBeGreaterThanOrEqual(70)
	})
})
