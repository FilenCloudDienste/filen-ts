import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { openOdtAsDocx } from "../core/odt/index"
import { PdfWriteError } from "../core/pdfwrite/index"
import { PresentationError } from "../core/presentation/model"
import type { SheetFileKind } from "../core/sheet/protocol"
import type { DocxEngineServices } from "../dom/docx/index"
import { exportDocxPdf } from "../dom/docx/pdf"
import { DocxPdfExportError } from "../dom/docx/pdfClient"
import { installPresentationRealm } from "../dom/presentation/services"
import { inThreadSheetHost } from "../dom/sheet/host"
import { exportSheetPdf } from "../react/sheet/print/pdfExport"
import { CORPUS_DIR } from "./corpusDir"
import { runVeraPdf } from "./oracles/veraPdf"
import { pdfAssets } from "./docxPdfFixtures"
import { HmtxMeasurer, nodeFontAssets as layoutFontAssets, nodeFontHost } from "./layoutFixtures"
import { deckPdf, installTestRealm, openDeck } from "./presentationExportFixtures"
import { nodeFontAssets, pdfBytes, workbookRequest } from "./sheetPdfFixtures"
import { IMMEDIATE } from "./sheetSessionFixtures"
import { budget } from "./timing"

// A deterministic sample of each corpus family exported to PDF as the apps export it: Word and ODT documents opened,
// laid out and painted (exportDocxPdf), workbooks printed whole (exportSheetPdf), decks written by the PDF job. Each
// export either yields a complete PDF with the model's page count, or is refused with a typed reason Office also stops
// at; it never throws. With qpdf on the PATH (or FILEN_OFFICE_QPDF), every PDF must also pass `qpdf --check` cleanly.
// With FILEN_OFFICE_VERAPDF naming veraPDF's CLI (the nightly office-corpus job), a smaller sample is exported and each
// PDF must pass veraPDF's PDF/UA-1 profile, but for the rules UA_ALLOWED names for its source.

const VERAPDF = process.env["FILEN_OFFICE_VERAPDF"] || undefined

// Files per directory, evenly spread over its sorted names, and the largest source taken (CPU and RAM bound). veraPDF
// starts a JVM per file, hence its smaller sample.
const PER_DIRECTORY = VERAPDF === undefined ? 8 : 3
const MAX_SOURCE_BYTES = 1_500_000

// Sources whose export cannot conform to PDF/UA-1 for a reason of their content, keyed "<directory>/<name>": the
// veraPDF rules ("<clause>-<testNumber>" of ISO 14289-1) the export may fail, with why. An entry must still fail each of
// its rules, so a fix removes it.
const UA_ALLOWED: Readonly<Record<string, { readonly rules: readonly string[]; readonly reason: string }>> = {}

const WORD = ["docx", "docm", "dotx", "odt"] as const
const SHEET = ["xlsx", "xlsm", "xltx", "ods"] as const satisfies readonly SheetFileKind[]
const DECK = ["pptx", "pptm", "potx", "ppsx", "odp"] as const

// Refusals Office also ends at without the user: a file that needs its password, one under rights management, and
// a workbook with nothing to print. Any other refusal (an open failure included) fails the file.
const ACCEPTED_REFUSALS: readonly string[] = ["needsPassword", "rightsManaged", "unsupportedEncryption", "nothing"]

type Outcome =
	{ readonly kind: "pdf"; readonly bytes: Uint8Array; readonly pages: number } | { readonly kind: "refused"; readonly reason: string }

function qpdfBinary(): string | undefined {
	const configured = process.env["FILEN_OFFICE_QPDF"]

	if (configured !== undefined && configured !== "") return configured

	return spawnSync("qpdf", ["--version"], { encoding: "utf8" }).status === 0 ? "qpdf" : undefined
}

// Every k-th file of the directory (sorted by name) at most MAX_SOURCE_BYTES long.
function corpusSample(directory: string, count: number = PER_DIRECTORY): string[] {
	const path = join(CORPUS_DIR, directory)

	if (!existsSync(path)) return []

	const names = readdirSync(path)
		.filter(name => !name.startsWith(".") && statSync(join(path, name)).size <= MAX_SOURCE_BYTES)
		.sort()

	if (names.length <= count) return names

	const out: string[] = []

	for (let k = 0; k < count; k++) out.push(names[Math.floor(((k + 0.5) * names.length) / count)] ?? "")

	return out
}

function docxServices(): DocxEngineServices {
	return {
		fontHost: nodeFontHost,
		replayFonts: false,
		fontAssets: layoutFontAssets,
		measurer: new HmtxMeasurer(),
		yield: () => Promise.resolve(),
		sliceMs: 1_000_000,
		// As the worker's services: ODT is translated where it is laid out.
		openOdt: openOdtAsDocx
	}
}

async function wordPdf(bytes: Uint8Array, name: string, format: "docx" | "odt"): Promise<Outcome> {
	let pages = -1

	try {
		const exported = await exportDocxPdf(bytes, docxServices(), pdfAssets, {
			options: { title: name, deterministic: true, format },
			signal: { aborted: false },
			onProgress: (phase, _done, total) => {
				if (phase === "pages") pages = total
			}
		})

		return { kind: "pdf", bytes: new Uint8Array(await exported.blob.arrayBuffer()), pages }
	} catch (error) {
		if (error instanceof DocxPdfExportError || error instanceof PdfWriteError) return { kind: "refused", reason: error.reason }

		throw error
	}
}

async function sheetPdf(bytes: Uint8Array, name: string, kind: SheetFileKind): Promise<Outcome> {
	const opened = await inThreadSheetHost().open(bytes, { kind, slicing: IMMEDIATE }, () => undefined)

	// An encrypted workbook refused unopened: "unsupported" is an encryption Filen does not implement (an ODF one).
	if (opened.kind === "refused") {
		return { kind: "refused", reason: opened.reason === "unsupported" ? "unsupportedEncryption" : opened.reason }
	}

	if (opened.kind !== "opened") return { kind: "refused", reason: "reason" in opened ? opened.reason : opened.kind }

	const { session, info } = opened

	try {
		const request = await workbookRequest(session, info, name)
		const result = await exportSheetPdf(request, { session, assets: nodeFontAssets, deterministic: true })

		return result.ok
			? { kind: "pdf", bytes: pdfBytes(result.output.parts), pages: result.pages }
			: { kind: "refused", reason: result.reason }
	} finally {
		session.close()
	}
}

async function deckPdfOf(bytes: Uint8Array, format: "pptx" | "odp"): Promise<Outcome> {
	try {
		const context = await openDeck(bytes, undefined, format)
		const { bytes: pdf } = await deckPdf(context)

		// Slides one per page, hidden ones included.
		return { kind: "pdf", bytes: pdf, pages: context.session.deck.slides.length }
	} catch (error) {
		if (error instanceof PresentationError || error instanceof PdfWriteError) return { kind: "refused", reason: error.reason }

		throw error
	}
}

const QPDF = qpdfBinary()
const scratch = QPDF === undefined && VERAPDF === undefined ? "" : mkdtempSync(join(tmpdir(), "pdfexportcorpus-"))
const TAIL = new TextEncoder().encode("%%EOF")

afterAll(() => {
	if (scratch !== "") rmSync(scratch, { recursive: true, force: true })
})

// A complete PDF: the header, the final %%EOF (trailing end-of-line allowed), pdf.js reads the model's page count,
// and qpdf (when present) finds no syntax or stream errors.
async function expectValidPdf(outcome: Extract<Outcome, { kind: "pdf" }>, label: string): Promise<void> {
	const { bytes } = outcome

	expect(new TextDecoder().decode(bytes.subarray(0, 5)), label).toBe("%PDF-")

	let end = bytes.length

	while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d || bytes[end - 1] === 0x20)) end--

	expect(
		TAIL.every((byte, k) => bytes[end - TAIL.length + k] === byte),
		`${label}: ends with %%EOF`
	).toBe(true)
	expect(outcome.pages, `${label}: pages`).toBeGreaterThan(0)

	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })

	try {
		expect((await task.promise).numPages, `${label}: page count`).toBe(outcome.pages)
	} finally {
		await task.destroy()
	}

	if (scratch === "") return

	const path = join(scratch, "out.pdf")

	writeFileSync(path, bytes)

	if (QPDF !== undefined) {
		// qpdf exits 0 only when clean (2 on errors, 3 on warnings).
		const check = spawnSync(QPDF, ["--check", path], { encoding: "utf8" })

		expect(check.status, `${label}: ${check.stdout}${check.stderr}`).toBe(0)
	}

	if (VERAPDF !== undefined) {
		expect(runVeraPdf(VERAPDF, "ua1", path).failedRules, `${label}: PDF/UA-1 rules failed`).toEqual(
			UA_ALLOWED[label]?.rules.toSorted() ?? []
		)
	}
}

async function check(label: string, outcome: Promise<Outcome>): Promise<void> {
	const result = await outcome

	if (result.kind === "refused") {
		expect(ACCEPTED_REFUSALS, `${label}: refused ${result.reason}`).toContain(result.reason)

		return
	}

	await expectValidPdf(result, label)
}

const read = (directory: string, name: string): Uint8Array => new Uint8Array(readFileSync(join(CORPUS_DIR, directory, name)))

describe("PDF export of a corpus sample", () => {
	beforeAll(() => {
		installTestRealm()
	})

	afterAll(() => {
		installPresentationRealm(undefined)
	})

	it.skipIf(VERAPDF === undefined)("allows PDF/UA-1 failures only for sampled sources", () => {
		for (const key of Object.keys(UA_ALLOWED)) {
			const [directory = "", name = ""] = key.split("/")

			expect(corpusSample(directory), key).toContain(name)
		}
	})

	for (const directory of WORD)
		describe.skipIf(!existsSync(join(CORPUS_DIR, directory)))(directory, () => {
			for (const name of corpusSample(directory))
				it(name, { timeout: budget(120_000) }, () =>
					check(`${directory}/${name}`, wordPdf(read(directory, name), name, directory === "odt" ? "odt" : "docx"))
				)
		})

	for (const directory of SHEET)
		describe.skipIf(!existsSync(join(CORPUS_DIR, directory)))(directory, () => {
			for (const name of corpusSample(directory))
				it(name, { timeout: budget(120_000) }, () =>
					check(`${directory}/${name}`, sheetPdf(read(directory, name), name, directory))
				)
		})

	for (const directory of DECK)
		describe.skipIf(!existsSync(join(CORPUS_DIR, directory)))(directory, () => {
			for (const name of corpusSample(directory))
				it(name, { timeout: budget(120_000) }, () =>
					check(`${directory}/${name}`, deckPdfOf(read(directory, name), directory === "odp" ? "odp" : "pptx"))
				)
		})
})
