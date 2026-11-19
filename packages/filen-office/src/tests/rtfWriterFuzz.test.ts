import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import type { Transaction } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import type { DocxEditorSession } from "@filen/office/core/docx/edit"
import { DocxSaveError } from "@filen/office/core/docx/write"
import { readRtf } from "../core/rtf/index"
import { RtfWriteRefusal } from "../core/rtf/write/out"
import { writeRtf, type RtfEdits } from "../core/rtf/write/writer"
import { CORPUS_DIR } from "./corpusDir"
import { rng, type Rand } from "./fuzz/config"
import { baseOps } from "./fuzz/ops/base"
import { formattingOps } from "./fuzz/ops/formatting"
import type { EditOp, OpContext } from "./fuzz/ops/index"
import { tableOps } from "./fuzz/ops/tables"
import { editRtf, editsOf, latin1 } from "./rtfWriteFixtures"

// Random edit sequences (the docx fuzzers' paged ops: typing, deleting, splitting, joining, formatting, lists,
// styles, tables, undo) on RTF documents, each saved through the RTF writer. A save either reads back as the
// edit made it, checked here independently of the writer's own proof (every paragraph's text in order), or is
// refused with a reason: no proof failure goes unreported. FILEN_OFFICE_RTF_FUZZ_RUNS sets the seeds per file
// (default 3); corpus files are added where the corpus exists. An op, dispatch or command that throws, or a save
// preparation that fails other than with the docx writer's refusal, fails the run with its file, seed and op log.

const RUNS = Number(process.env["FILEN_OFFICE_RTF_FUZZ_RUNS"] ?? 3)
const STEPS = 12
const OPS: readonly EditOp[] = [...baseOps, ...formattingOps, ...tableOps].filter(op => op.harness === "paged")

const SYNTHETIC = latin1(
	"{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1\\fswiss Arial;}}{\\colortbl;\\red255\\green0\\blue0;}" +
		"{\\stylesheet{\\s0 Normal;}{\\s1\\b\\fs32 heading 1;}}" +
		"\\pard\\plain\\s1\\b\\fs32 A heading line\\par\n" +
		"\\pard\\plain\\f0\\fs24 First paragraph {\\i with italics} and more words here\\par\n" +
		"{\\pard\\plain\\f0\\fs24 Second paragraph {\\b bold}{\\f1\\cf1  red Arial}\\par}\n" +
		"\\pard\\plain\\qc\\f0\\fs24 Centred caf\\'e9 text\\tab tabbed\\line new line\\par\n" +
		"\\trowd\\trgaph108\\trleft-108\\cellx3000\\cellx6000\\pard\\plain\\intbl A1 cell text\\cell B1 cell text\\cell\\row\n" +
		"\\trowd\\trgaph108\\trleft-108\\cellx3000\\cellx6000\\pard\\plain\\intbl A2 cell text\\cell B2 cell text\\cell\\row\n" +
		"\\pard\\plain\\f0\\fs24 Last paragraph \\u8364?uro\\par\n" +
		"}"
)

function corpusSample(): { name: string; bytes: Uint8Array }[] {
	const directory = join(CORPUS_DIR, "rtf")

	if (!existsSync(directory)) return []

	// Small files, a spread of writers.
	return readdirSync(directory)
		.filter(name => name.endsWith(".rtf"))
		.sort()
		.filter(name => statSync(join(directory, name)).size < 120_000)
		.filter((_, index) => index % 4 === 0)
		.map(name => ({ name, bytes: new Uint8Array(readFileSync(join(directory, name))) }))
}

function errorText(error: unknown): string {
	return (error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)).slice(0, 800)
}

// A transaction that cannot be built for this document is expected and only logged; a dispatch or command that
// throws is an editor crash, recorded through `crashed`.
function context(session: DocxEditorSession, rand: Rand, crashed: (what: string, error: unknown) => void): OpContext {
	return {
		rand,
		session,
		editor: undefined,
		numIds: [],
		styleIds: [],
		transact(label, build) {
			let tr: Transaction | void

			try {
				tr = build(session.state.tr)
			} catch (error) {
				return `build threw ${String(error).slice(0, 60)}`
			}

			if (tr === undefined) return "noop"

			try {
				return String(session.dispatch(tr))
			} catch (error) {
				crashed(`dispatch ${label}`, error)

				return "dispatch threw"
			}
		},
		execute(label, command) {
			try {
				return String(session.execute(command))
			} catch (error) {
				crashed(`execute ${label}`, error)

				return "execute threw"
			}
		}
	}
}

// Every w:t and w:delText of the body's part, paragraph by paragraph (an optional or non-breaking hyphen as the
// character it is: RTF has them as characters).
function bodyText(source: string): string {
	const xml = source.replaceAll("<w:softHyphen/>", "<w:t>\u00ad</w:t>").replaceAll("<w:noBreakHyphen/>", "<w:t>\u2011</w:t>")

	return [...xml.matchAll(/<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gu)]
		.map(paragraph =>
			[...paragraph[0].matchAll(/<w:(?:t|delText)(?: [^>]*)?>([^<]*)<\/w:(?:t|delText)>/gu)].map(match => match[1]).join("")
		)
		.join("\n")
}

describe("RTF writer fuzz", () => {
	it("saves random edit sequences as edited or refuses them with a reason", { timeout: 1_800_000 }, async () => {
		const files = [{ name: "synthetic", bytes: SYNTHETIC }, ...corpusSample()]
		const outcomes = { saved: 0, refused: 0, steps: 0 }
		const reasons = new Map<string, number>()
		const findings: string[] = []

		for (const file of files) {
			for (let run = 0; run < RUNS; run++) {
				const seed = 0x5eed + run * 7919 + file.bytes.length
				const rand = rng(seed)
				const editing = await editRtf(file.bytes)

				editing.opened.context.identity.author = "Fuzz"

				const log: string[] = []
				const crashed = (what: string, error: unknown): void => {
					findings.push(`${file.name} run ${run} seed ${seed}: ${what} threw ${errorText(error)}\n${log.join("\n")}`)
				}

				for (let step = 0; step < STEPS; step++) {
					const op = OPS[Math.floor(rand() * OPS.length)]

					if (op === undefined) continue

					try {
						log.push(
							`${op.name}: ${await op.run(context(editing.session, rand, (what, error) => crashed(`op ${op.name} ${what}`, error)))}`
						)
					} catch (error) {
						crashed(`op ${op.name}`, error)
					}

					outcomes.steps++
				}

				let edits: RtfEdits

				try {
					edits = await editsOf(editing)
				} catch (error) {
					if (!(error instanceof DocxSaveError)) {
						crashed("save preparation", error)

						continue
					}

					// The docx writer's gates refused the edited document: a refusal with its reason.
					outcomes.refused++
					reasons.set(`docx ${error.reason}`, (reasons.get(`docx ${error.reason}`) ?? 0) + 1)

					continue
				}

				try {
					const written = await writeRtf(editing.source, edits)
					const read = await readRtf(written.bytes)

					expect(read.ok, `${file.name} run ${run} seed ${seed}`).toBe(true)

					if (!read.ok) continue

					const expected = edits.parts.get("word/document.xml") ?? unzipSync(editing.source.read.docx)["word/document.xml"]
					const actual = unzipSync(read.docx)["word/document.xml"]

					expect(bodyText(strFromU8(actual ?? new Uint8Array())), `${file.name} run ${run} seed ${seed}\n${log.join("\n")}`).toBe(
						bodyText(strFromU8(expected ?? new Uint8Array()))
					)
					outcomes.saved++
				} catch (error) {
					if (!(error instanceof RtfWriteRefusal)) throw error

					outcomes.refused++
					if (process.env["RTF_FUZZ_LOG"] !== undefined && error.reason === process.env["RTF_FUZZ_LOG"])
						console.log(file.name, run, log, error.message, error.detail ?? "")
					reasons.set(error.message.slice(0, 700), (reasons.get(error.message.slice(0, 700)) ?? 0) + 1)
				}
			}
		}

		console.log("rtf fuzz", outcomes, Object.fromEntries(reasons))

		expect(findings.slice(0, 10)).toEqual([])
		expect(outcomes.saved).toBeGreaterThan(0)
	})
})
