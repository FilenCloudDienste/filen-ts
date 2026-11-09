import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { unzipSync } from "fflate"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { convertSheet, type SheetLossyFeature, type SheetSourceFormat } from "../core/ods/convert/index"
import { CORPUS_DIR } from "./corpusDir"
import { OpenXmlSdk, openXmlSdkMissing } from "./oracles/openXmlSdk"
import { exportShown, sheetOffices, sheetProfile, type ShownWorkbook } from "./oracles/sheet/libreOffice"

// Every corpus workbook converted (xlsx family → .ods, .ods → .xlsx), each output checked. Opt-in
// (FILEN_OFFICE_CONVERT_CORPUS=1), and each oracle where it is named:
// - FILEN_OFFICE_ODFVALIDATOR=<odfvalidator jar>: no .ods output has an error as an extended document (-e; ODF 1.3
//   Part 3 §2.2.2, foreign elements and attributes §3.17), which it is: LibreOffice's calcext/loext markup, declared
//   and placed where LibreOffice writes it (the default, -c, refuses any foreign markup, LibreOffice's own files' too);
// - FILEN_OFFICE_JING=<jing jar> and FILEN_OFFICE_ODF_RNG=<OpenDocument-v1.3-schema.rng>: every part of every .ods
//   output is valid ODF 1.3;
// - FILEN_OFFICE_OOXML_VALIDATOR (oracles/openXmlSdk.ts): no .xlsx output has an error;
// - FILEN_OFFICE_SOFFICE naming a 7.5 install: LibreOffice opens every output, showing its sheets as it shows the
//   source's (CSV, as shown).
// FILEN_OFFICE_CONVERT_REPORT names a Markdown file the lossy features of each file are written to.

const RUN = process.env["FILEN_OFFICE_CONVERT_CORPUS"] === "1"
const ODF_VALIDATOR = process.env["FILEN_OFFICE_ODFVALIDATOR"] ?? ""
const JING = process.env["FILEN_OFFICE_JING"] ?? ""
const RNG = process.env["FILEN_OFFICE_ODF_RNG"] ?? ""
const REPORT = process.env["FILEN_OFFICE_CONVERT_REPORT"] ?? ""
const OFFICE = sheetOffices().find(office => office.version.startsWith("7.5."))
const SCRATCH = process.env["FILEN_OFFICE_SHEET_LO_SCRATCH"] || tmpdir()
const FAMILIES: Readonly<Record<string, SheetSourceFormat>> = { xlsx: "xlsx", xlsm: "xlsx", xltx: "xlsx", xltm: "xlsx", ods: "ods" }
// Refusals a source earns of its own: a password, content past what the reader holds.
const SOURCE_REFUSALS: ReadonlySet<string> = new Set(["encrypted", "tooLarge", "notSource", "corrupt"])

interface Converted {
	readonly source: string
	readonly output: string
	readonly from: SheetSourceFormat
	readonly lossy: readonly SheetLossyFeature[]
}

function trimmed(rows: readonly (readonly string[])[]): string[][] {
	const out = rows.map(row => {
		const copy = [...row]

		while (copy.length > 0 && copy[copy.length - 1] === "") copy.pop()

		return copy
	})

	while (out.length > 0 && out[out.length - 1]?.length === 0) out.pop()

	return out
}

function shownBySheet(workbook: ShownWorkbook | undefined): Map<string, string> | null {
	if (workbook?.ok !== true) return null

	return new Map(workbook.sheets.map(sheet => [sheet.name, JSON.stringify(trimmed(sheet.text))]))
}

describe.skipIf(!RUN || !existsSync(CORPUS_DIR))("conversions of the corpus workbooks", () => {
	let work = ""
	const converted: Converted[] = []
	const refused: string[] = []

	beforeAll(async () => {
		work = mkdtempSync(join(SCRATCH, "filen-office-convert-"))

		for (const family of Object.keys(FAMILIES)) {
			const directory = join(CORPUS_DIR, family)

			if (!existsSync(directory)) continue

			mkdirSync(join(work, family), { recursive: true })

			for (const name of readdirSync(directory).sort()) {
				const from = FAMILIES[family] as SheetSourceFormat
				const source = join(directory, name)
				const result = await convertSheet(new Uint8Array(readFileSync(source)), from, from === "xlsx" ? "ods" : "xlsx")

				if (!result.ok) {
					refused.push(`${name}: ${result.reason}: ${result.message}`)

					continue
				}

				const output = join(work, family, `${name}.${from === "xlsx" ? "ods" : "xlsx"}`)

				writeFileSync(output, result.bytes)
				converted.push({ source, output, from, lossy: result.lossy })
			}
		}

		if (REPORT !== "") {
			const lines = ["| file | lost |", "|---|---|"]

			for (const item of converted)
				lines.push(
					`| ${basename(item.source)} | ${item.lossy.map(feature => `${feature.kind} ${feature.count}`).join(", ") || "—"} |`
				)

			writeFileSync(REPORT, `${lines.join("\n")}\n\nRefused:\n\n${refused.map(line => `- ${line}`).join("\n")}\n`)
		}
	}, 7_200_000)

	afterAll(() => {
		if (work !== "") rmSync(work, { recursive: true, force: true })
	})

	it("converts every workbook but those its source refuses (a password, content past what is read)", () => {
		expect(converted.length).toBeGreaterThan(300)
		expect(refused.filter(line => !SOURCE_REFUSALS.has(line.split(": ")[1] ?? ""))).toEqual([])
	})

	it.skipIf(ODF_VALIDATOR === "")("writes .ods files odfvalidator finds no error in", { timeout: 3_600_000 }, () => {
		const files = converted.filter(item => item.from === "xlsx").map(item => item.output)
		const errors: string[] = []

		for (let start = 0; start < files.length; start += 50) {
			const run = spawnSync("java", ["-jar", ODF_VALIDATOR, "-e", ...files.slice(start, start + 50)], {
				encoding: "utf8",
				maxBuffer: 1 << 28
			})

			for (const line of `${run.stdout}\n${run.stderr}`.split("\n")) if (/:\s+(?:Error|Fatal):/.test(line)) errors.push(line)
		}

		expect(errors.slice(0, 20)).toEqual([])
	})

	it.skipIf(JING === "" || RNG === "")("writes .ods parts valid against the ODF 1.3 schema", { timeout: 3_600_000 }, () => {
		const errors: string[] = []
		const parts = join(work, "parts")

		for (const item of converted.filter(entry => entry.from === "xlsx")) {
			const directory = join(parts, basename(item.output))
			const entries = unzipSync(new Uint8Array(readFileSync(item.output)))
			const files: string[] = []

			mkdirSync(directory, { recursive: true })

			for (const part of ["content.xml", "styles.xml", "settings.xml", "meta.xml"]) {
				const bytes = entries[part]

				if (bytes === undefined) continue

				const file = join(directory, part)

				writeFileSync(file, bytes)
				files.push(file)
			}

			const run = spawnSync("java", ["-jar", JING, RNG, ...files], { encoding: "utf8", maxBuffer: 1 << 26 })

			if (run.status !== 0) errors.push(`${basename(item.output)}: ${`${run.stdout}${run.stderr}`.slice(0, 400)}`)
		}

		expect(errors.slice(0, 20)).toEqual([])
	})

	it.skipIf(openXmlSdkMissing() !== undefined)(
		"writes .xlsx files the Open XML SDK finds no error in",
		{ timeout: 3_600_000 },
		async () => {
			const sdk = new OpenXmlSdk()
			const errors: string[] = []

			try {
				for (const item of converted.filter(entry => entry.from === "ods")) {
					const result = await sdk.validate(item.output)

					if (result.fatal !== undefined) errors.push(`${basename(item.output)}: ${result.fatal}`)

					for (const error of result.errors) errors.push(`${basename(item.output)}: ${error.part ?? ""} ${error.description}`)
				}
			} finally {
				await sdk.close()
			}

			expect(errors.slice(0, 20)).toEqual([])
		}
	)

	it.skipIf(OFFICE === undefined)(
		"opens every output in LibreOffice 7.5, each sheet shown as it shows the source's",
		{ timeout: 7_200_000 },
		async () => {
			const office = OFFICE

			if (office === undefined) return

			const profile = sheetProfile(work, "convert")
			const sources = await exportShown(
				office,
				profile,
				converted.map(item => item.source),
				join(work, "shown-source"),
				120_000,
				false
			)
			const outputs = await exportShown(
				office,
				profile,
				converted.map(item => item.output),
				join(work, "shown-output"),
				120_000,
				false
			)
			const problems: string[] = []

			converted.forEach((item, index) => {
				const before = shownBySheet(sources[index])
				const after = shownBySheet(outputs[index])

				if (after === null) {
					problems.push(`${basename(item.output)}: LibreOffice cannot open it`)

					return
				}

				if (before === null) return

				for (const [sheet, text] of before)
					if (after.has(sheet) && after.get(sheet) !== text) problems.push(`${basename(item.source)} ${sheet}: shown differently`)
			})

			expect(problems.slice(0, 40)).toEqual([])
		}
	)
})
