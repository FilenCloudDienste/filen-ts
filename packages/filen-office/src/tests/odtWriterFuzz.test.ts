import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { strFromU8 } from "fflate"
import { describe, expect, it } from "vitest"
import type { DocxEditorSession } from "@filen/office/core/docx/edit"
import { bytesSource } from "@filen/office/core/opc"
import { OdfPackage } from "../core/odf/index"
import { translateOdt } from "../core/odt/index"
import { OdtWriteRefusal, writeOdt } from "../core/odt/write/writer"
import { CORPUS_DIR } from "./corpusDir"
import { rng, type Rand } from "./fuzz/config"
import { baseOps } from "./fuzz/ops/base"
import { formattingOps } from "./fuzz/ops/formatting"
import type { EditOp, OpContext } from "./fuzz/ops/index"
import { tableOps } from "./fuzz/ops/tables"
import { odtBytes } from "./odtFixtures"
import { editOdt, odtEditsOf } from "./odtWriteFixtures"

// Random edit sequences (the docx fuzzers' paged ops: typing, deleting, splitting, joining, formatting, lists, styles,
// tables, undo) on ODF text documents, each saved through the ODT writer. A save either reads back as the edit made
// it, checked here independently of the writer's own proof (every paragraph's text in order, and how many tables and
// rows), or is refused with a reason: no proof failure goes unreported. FILEN_OFFICE_ODT_FUZZ_RUNS sets the seeds
// per file (default 3), FILEN_OFFICE_ODT_FUZZ_FROM the first (default 0); corpus files are added where the corpus exists.
// A sampled corpus package the reader refuses (encrypted, or not a package) is left out; any other refusal fails.

const RUNS = Number(process.env["FILEN_OFFICE_ODT_FUZZ_RUNS"] ?? 3)
const FROM = Number(process.env["FILEN_OFFICE_ODT_FUZZ_FROM"] ?? 0)
const STEPS = 12
const OPS: readonly EditOp[] = [...baseOps, ...formattingOps, ...tableOps].filter(op => op.harness === "paged")

const SYNTHETIC = odtBytes({
	automatic:
		'<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center"/></style:style>' +
		'<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>' +
		'<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.25in" fo:margin-left="0.5in"/></style:list-level-properties></text:list-level-style-number></text:list-style>',
	styles: '<style:style style:name="Standard" style:family="paragraph"/><style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:default-outline-level="1"><style:text-properties fo:font-size="16pt"/></style:style>',
	body:
		'<text:h text:style-name="Heading_20_1" text:outline-level="1">A heading line</text:h>' +
		'<text:p>First paragraph <text:span text:style-name="T1">with bold</text:span> and more words here</text:p>' +
		'<text:p text:style-name="P1">Centred café text<text:tab/>tabbed<text:line-break/>new line</text:p>' +
		'<text:list text:style-name="L1"><text:list-item><text:p>One item of a list</text:p></text:list-item><text:list-item><text:p>Two items of a list</text:p></text:list-item></text:list>' +
		'<table:table table:name="T"><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell office:value-type="string"><text:p>A1 cell text</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>B1 cell text</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell office:value-type="string"><text:p>A2 cell text</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>B2 cell text</text:p></table:table-cell></table:table-row></table:table>' +
		"<text:p>Last paragraph €uro</text:p>"
})

function corpusSample(): { name: string; bytes: Uint8Array }[] {
	const directory = join(CORPUS_DIR, "odt")

	if (!existsSync(directory)) return []

	return readdirSync(directory)
		.filter(name => name.endsWith(".odt"))
		.sort()
		.map(name => ({ name, bytes: new Uint8Array(readFileSync(join(directory, name))) }))
		.filter(file => file.bytes.length < 400_000)
		.filter((_, index) => index % 3 === 0)
}

function context(session: DocxEditorSession, rand: Rand): OpContext {
	return {
		rand,
		session,
		editor: undefined,
		numIds: [],
		styleIds: [],
		transact(_label, build) {
			try {
				const tr = build(session.state.tr)

				return tr === undefined ? "noop" : String(session.dispatch(tr))
			} catch (error) {
				return `threw ${String(error)}`
			}
		},
		execute(_label, command) {
			try {
				return String(session.execute(command))
			} catch (error) {
				return `threw ${String(error)}`
			}
		}
	}
}

// Every paragraph's text in order (an optional or non-breaking hyphen as the character it is), and the tables and rows.
function bodyText(source: string): string {
	const xml = source
		.replaceAll("<w:softHyphen/>", "<w:t>­</w:t>")
		.replaceAll("<w:noBreakHyphen/>", "<w:t>‑</w:t>")
		.replaceAll("<w:tab/>", "<w:t>\t</w:t>")
	const text = [...xml.matchAll(/<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gu)]
		.map(paragraph =>
			[...paragraph[0].matchAll(/<w:(?:t|delText)(?: [^>]*)?>([^<]*)<\/w:(?:t|delText)>/gu)].map(match => match[1]).join("")
		)
		.join("\n")
		.replace(/&(lt|gt|amp|quot|apos);/gu, (_entity, name: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[name] ?? "")

	return `${text}\n#tables ${(xml.match(/<w:tbl>/gu) ?? []).length} rows ${(xml.match(/<w:tr[ >]/gu) ?? []).length}`
}

describe("ODT writer fuzz", () => {
	it("saves random edit sequences as edited or refuses them with a reason", { timeout: 3_600_000 }, async () => {
		const files = [{ name: "synthetic", bytes: SYNTHETIC }, ...corpusSample()]

		const outcomes = { saved: 0, refused: 0, steps: 0 }
		const reasons = new Map<string, number>()
		const unopened = new Map<string, string>()

		for (const file of files) {
			const pkg = await OdfPackage.open(bytesSource(file.bytes), { kinds: ["text"] })

			if (!pkg.ok) {
				unopened.set(file.name, pkg.reason)

				continue
			}

			for (let run = FROM; run < FROM + RUNS; run++) {
				const rand = rng(0x0d7 + run * 7919 + file.bytes.length)
				const editing = await editOdt(file.bytes)

				editing.opened.context.identity.author = "Fuzz"

				for (let step = 0; step < STEPS; step++) {
					const op = OPS[Math.floor(rand() * OPS.length)]

					if (op === undefined) continue

					try {
						await op.run(context(editing.session, rand))
					} catch {
						// An op that cannot apply to this document.
					}

					outcomes.steps++
				}

				const edits = await odtEditsOf(editing).catch(() => undefined)

				if (edits === undefined) continue

				try {
					const written = await writeOdt(editing.source, edits)
					const read = await translateOdt(bytesSource(written.bytes))

					expect(read.ok, `${file.name} run ${run}`).toBe(true)

					if (!read.ok) continue

					const expected =
						edits.parts.get("word/document.xml") ?? (editing.source.translation.parts.get("word/document.xml") as Uint8Array)
					const actual = read.translation.parts.get("word/document.xml") as Uint8Array

					expect(bodyText(strFromU8(actual)), `${file.name} run ${run}`).toBe(bodyText(strFromU8(expected)))
					outcomes.saved++
				} catch (error) {
					if (!(error instanceof OdtWriteRefusal)) throw error

					outcomes.refused++
					reasons.set(
						`${error.reason}: ${error.message.slice(0, 200)}`,
						(reasons.get(`${error.reason}: ${error.message.slice(0, 200)}`) ?? 0) + 1
					)
				}
			}
		}

		console.log("odt fuzz", outcomes, Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1]).slice(0, 25)), {
			unopened: Object.fromEntries(unopened)
		})

		expect([...unopened.values()].filter(reason => reason !== "encrypted" && reason !== "invalidPackage")).toEqual([])
		expect(outcomes.saved).toBeGreaterThan(0)
	})
})
