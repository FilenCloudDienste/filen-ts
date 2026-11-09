import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unzipSync } from "fflate"
import { afterAll, describe, expect, it } from "vitest"
import { buildDocxModel, openDocxPackage, type DocxModel } from "@filen/office/core/docx"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import { openOdtAsDocx } from "../core/odt/index"
import { decodeUtf8 } from "@filen/office/core/xml"
import { convertText, textSourceFormat, type TextRefusalReason, type TextSourceFormat } from "../core/convert/text/index"
import { symbolTable, symbolText } from "../core/fonts/symbols"
import { CORPUS_DIR } from "./corpusDir"
import { docxBodyText } from "./docToDocxFixtures"
import { OpenXmlSdk, openXmlSdkMissing } from "./oracles/openXmlSdk"
import { budget } from "./timing"

// The corpus converted: .odt and .rtf to .docx, .docx to .odt (.doc to .docx is the Word binary converter's, tested by
// docToDocxCorpus; here its packages are validated and scanned). Each file converts or is refused with its typed
// reason; no .docx holds a revision-session attribute or a field code of the translator's own; the body text reads
// back as the source's (odt → docx: the translation's, exactly; docx → odt: every word of the source's body, the
// target holding text that drawings held besides); time stays linear in the file size. Each oracle where it is named:
// - FILEN_OFFICE_OOXML_VALIDATOR (oracles/openXmlSdk.ts): the Open XML SDK finds no error in any .docx written;
// - FILEN_OFFICE_ODFVALIDATOR=<odfvalidator jar>: no .odt written has an error;
// - FILEN_OFFICE_JING=<jing jar> and FILEN_OFFICE_ODF_RNG=<OpenDocument-v1.3-schema.rng>: every part of every .odt
//   written is valid ODF 1.3.

const fetched = existsSync(join(CORPUS_DIR, "odt"))
const ODF_VALIDATOR = process.env["FILEN_OFFICE_ODFVALIDATOR"] ?? ""
const JING = process.env["FILEN_OFFICE_JING"] ?? ""
const RNG = process.env["FILEN_OFFICE_ODF_RNG"] ?? ""

function files(...families: string[]): string[] {
	if (!fetched) return []

	return families
		.flatMap(family =>
			existsSync(join(CORPUS_DIR, family)) ? readdirSync(join(CORPUS_DIR, family)).map(name => `${family}/${name}`) : []
		)
		.sort()
}

function load(path: string): Uint8Array {
	const bytes = readFileSync(join(CORPUS_DIR, path))

	return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

const REFUSED: Readonly<Record<string, TextRefusalReason>> = {
	"odt/odftk__testInvalidPkg2.odt": "corrupt",
	"odt/tika__testODTEncrypted.odt": "encrypted",
	"docx/lo__Encrypted_LO_Standard_abc.docx": "encrypted",
	"docx/lo__Encrypted_MSO2007_abc.docx": "encrypted",
	"docx/lo__Encrypted_MSO2010_abc.docx": "encrypted",
	"docx/lo__Encrypted_MSO2013_abc.docx": "encrypted",
	"docx/lo__tdf165348_broken_package.docx": "corrupt",
	"docx/mso__example_password.docx": "encrypted",
	"docx/oxsdk__document_with_password.docx": "encrypted",
	"docx/poi__bug53475-password-is-pass.docx": "encrypted",
	"docx/poi__bug53475-password-is-solrcell.docx": "encrypted"
}

// Words as their letters and digits; a symbol font's private-use character (U+F0xx: Word's w:sym, here as the
// Symbol font draws it) compares as the Unicode character the conversion writes for it.
const SYMBOL = symbolTable("Symbol")
const words = (text: string): string[] =>
	(SYMBOL === undefined ? text : symbolText(SYMBOL, text))
		.split(/[\s\u00a0]+/u)
		.map(word => word.replace(/[^\p{L}\p{N}]/gu, ""))
		.filter(word => word !== "")

async function docxModel(bytes: Uint8Array): Promise<DocxModel> {
	const opened = await openDocxPackage(bytesSource(bytes))

	if (!opened.ok) throw new Error(`${opened.reason}: ${opened.message}`)

	return buildDocxModel(opened.package)
}

async function odtModel(bytes: Uint8Array): Promise<DocxModel> {
	const opened = await openOdtAsDocx(bytesSource(bytes), { strict: true })

	if (!opened.ok) throw new Error(`${opened.reason}: ${opened.message}`)

	return buildDocxModel(opened.package)
}

// What no converted .docx may hold: a revision-session id (the ODT translator's origin offsets ride on w:rsidR), and
// the translator's field codes naming ODF elements and variables.
async function internalMarkers(bytes: Uint8Array): Promise<string[]> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const found: string[] = []

	for (const entry of archive.entries) {
		if (!entry.name.endsWith(".xml")) continue

		const xml = decodeUtf8(await archive.read(entry))

		for (const match of xml.matchAll(
			/\sw:rsid[A-Za-z]*="[^"]*"|w:instr="\s*(?:DOCPROPERTY|DOCVARIABLE)\b[^"]*"|<w:compatSetting w:name="flow-with-text"/gu
		))
			found.push(`${entry.name}: ${match[0]}`)
	}

	return found
}

// Words of `source` missing from `target` (a multiset difference).
function missing(source: readonly string[], target: readonly string[]): string[] {
	const counts = new Map<string, number>()

	for (const word of target) counts.set(word, (counts.get(word) ?? 0) + 1)

	const out: string[] = []

	for (const word of source) {
		const left = counts.get(word) ?? 0

		if (left === 0) out.push(word)
		else counts.set(word, left - 1)
	}

	return out
}

const target = (from: TextSourceFormat) => (from === "docx" ? "odt" : "docx")

describe.skipIf(!fetched)("text conversions over the corpus", () => {
	it("converts .odt and .rtf to .docx with the translation's text and no internal markers", { timeout: 600_000 }, async () => {
		const refused: Record<string, string> = {}
		const marked: string[] = []
		const differing: string[] = []
		const slow: string[] = []

		for (const path of files("odt", "ott", "rtf")) {
			const from = textSourceFormat(path)

			if (from === undefined) continue

			const bytes = load(path)
			const started = performance.now()
			const converted = await convertText(bytes, from, "docx")
			const ms = performance.now() - started

			if (!converted.ok) {
				refused[path] = converted.refusal.reason
				continue
			}

			// Generous for a loaded machine.
			if (ms > budget(1000 + (1500 * bytes.length) / 1e6)) slow.push(`${path}: ${ms.toFixed(0)} ms`)

			marked.push(...(await internalMarkers(converted.bytes)).map(found => `${path}: ${found}`))

			if (from === "odt") {
				const expected = words(docxBodyText(await odtModel(bytes)))
				const actual = words(docxBodyText(await docxModel(converted.bytes)))

				if (expected.join(" ") !== actual.join(" ")) differing.push(path)
			}
		}

		expect(refused).toEqual(Object.fromEntries(Object.entries(REFUSED).filter(([path]) => !path.startsWith("docx/"))))
		expect(marked).toEqual([])
		expect(differing).toEqual([])
		expect(slow).toEqual([])
	})

	it("carries text boxes', groups' and WordArt's text into the .docx", { timeout: 120_000 }, async () => {
		const cases: [string, TextSourceFormat, string][] = [
			["rtf/govuk__Armitt-Report-Response.rtf", "rtf", "Cockspur Street"],
			["rtf/govuk__Draft_Gambling_Act_2005_Order_2011_Validated.rtf", "rtf", "DRAFT"],
			["doc/govuk__Audit_20Committee_20minutes_202_20May_202013.doc", "doc", "DRAFT"]
		]
		const missing: string[] = []

		for (const [path, from, text] of cases) {
			const converted = await convertText(load(path), from, "docx")

			if (!converted.ok) {
				missing.push(`${path}: ${converted.refusal.reason}`)
				continue
			}

			const archive = await ZipArchive.open(bytesSource(converted.bytes))
			let found = false

			for (const entry of archive.entries)
				if (/^word\/.*\.xml$/u.test(entry.name) && decodeUtf8(await archive.read(entry)).includes(text)) found = true

			if (!found) missing.push(`${path}: ${text}`)
		}

		expect(missing).toEqual([])
	})

	it("converts .docx to .odt keeping every word of the body", { timeout: 900_000 }, async () => {
		const refused: Record<string, string> = {}
		const lost: Record<string, string[]> = {}
		const slow: string[] = []

		for (const path of files("docx", "docm", "dotx", "dotm")) {
			const bytes = load(path)
			const started = performance.now()
			const converted = await convertText(bytes, "docx", "odt")
			const ms = performance.now() - started

			if (!converted.ok) {
				refused[path] = converted.refusal.reason
				continue
			}

			if (ms > budget(1000 + (5000 * bytes.length) / 1e6)) slow.push(`${path}: ${ms.toFixed(0)} ms`)

			const gone = missing(words(docxBodyText(await docxModel(bytes))), words(docxBodyText(await odtModel(converted.bytes))))

			if (gone.length > 0) lost[path] = gone.slice(0, 10)
		}

		expect(refused).toEqual(Object.fromEntries(Object.entries(REFUSED).filter(([path]) => path.startsWith("docx/"))))
		expect(lost).toEqual({})
		expect(slow).toEqual([])
	})

	const sdkMissing = openXmlSdkMissing()

	it.skipIf(sdkMissing !== undefined)("writes .docx packages the Open XML SDK finds no error in", { timeout: 1_800_000 }, async () => {
		const sdk = new OpenXmlSdk()
		const scratch = mkdtempSync(join(tmpdir(), "filen-office-convert-text-"))
		const failures: string[] = []

		try {
			for (const path of files("odt", "ott", "rtf", "doc")) {
				const from = textSourceFormat(path)

				if (from === undefined || REFUSED[path] !== undefined) continue

				const converted = await convertText(load(path), from, target(from))

				if (!converted.ok) continue

				const file = join(scratch, "converted.docx")

				writeFileSync(file, converted.bytes)

				const validated = await sdk.validate(file)

				if (validated.fatal !== undefined) failures.push(`${path}: ${validated.fatal}`)

				for (const error of validated.errors) failures.push(`${path}: ${error.id} ${error.description} (${error.part ?? ""})`)
			}
		} finally {
			await sdk.close()
			rmSync(scratch, { recursive: true, force: true })
		}

		expect(failures).toEqual([])
	})

	it("writes .doc as .docx packages without internal markers", { timeout: 1_200_000 }, async () => {
		const marked: string[] = []

		for (const path of files("doc")) {
			const bytes = load(path)
			const converted = await convertText(bytes, "doc", "docx")

			// A package renamed .doc keeps the attributes its author's Word wrote.
			if (!converted.ok || (bytes[0] === 0x50 && bytes[1] === 0x4b)) continue

			marked.push(...(await internalMarkers(converted.bytes)).map(found => `${path}: ${found}`))
		}

		expect(marked).toEqual([])
	})

	describe.skipIf(ODF_VALIDATOR === "" && (JING === "" || RNG === ""))(".odt written from .docx against the ODF oracles", () => {
		let scratch = ""
		const written: string[] = []

		afterAll(() => {
			if (scratch !== "") rmSync(scratch, { recursive: true, force: true })
		})

		it("converts the corpus' .docx", { timeout: 900_000 }, async () => {
			scratch = mkdtempSync(join(tmpdir(), "filen-office-convert-odt-"))

			for (const path of files("docx", "docm", "dotx", "dotm")) {
				const converted = await convertText(load(path), "docx", "odt")

				if (!converted.ok) continue

				const file = join(scratch, `${String(written.length)}.odt`)

				writeFileSync(file, converted.bytes)
				written.push(file)
			}

			expect(written.length).toBeGreaterThan(300)
		})

		it.skipIf(ODF_VALIDATOR === "")("writes .odt files odfvalidator finds no error in", { timeout: 1_800_000 }, () => {
			const errors: string[] = []

			for (let start = 0; start < written.length; start += 50) {
				const run = spawnSync("java", ["-jar", ODF_VALIDATOR, ...written.slice(start, start + 50)], {
					encoding: "utf8",
					maxBuffer: 1 << 28
				})

				for (const line of `${run.stdout}\n${run.stderr}`.split("\n")) if (/:\s+(?:Error|Fatal):/u.test(line)) errors.push(line)
			}

			expect(errors.slice(0, 20)).toEqual([])
		})

		it.skipIf(JING === "" || RNG === "")("writes .odt parts valid against the ODF 1.3 schema", { timeout: 1_800_000 }, () => {
			const errors: string[] = []

			for (const file of written) {
				const directory = `${file}.parts`
				const entries = unzipSync(new Uint8Array(readFileSync(file)))
				const parts: string[] = []

				mkdirSync(directory, { recursive: true })

				for (const part of ["content.xml", "styles.xml", "settings.xml", "meta.xml"]) {
					const bytes = entries[part]

					if (bytes === undefined) continue

					writeFileSync(join(directory, part), bytes)
					parts.push(join(directory, part))
				}

				const run = spawnSync("java", ["-jar", JING, "-i", RNG, ...parts], { encoding: "utf8", maxBuffer: 1 << 26 })

				if (run.status !== 0) errors.push(`${file}: ${`${run.stdout}${run.stderr}`.slice(0, 400)}`)
			}

			expect(errors.slice(0, 20)).toEqual([])
		})
	})
})
