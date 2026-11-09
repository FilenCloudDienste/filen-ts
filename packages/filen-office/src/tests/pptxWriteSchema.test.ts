import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { bytesSource, memorySink, OpcPackage } from "@filen/office/core/opc"
import { encodeUtf8 } from "@filen/office/core/xml"
import { freshPptx } from "../core/pptx/write/fresh"
import { blankPptx } from "../core/templates/pptx"
import { FILEN_THEMES } from "../core/templates/themes/catalog"
import type { CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"
import { changedParts } from "./oracles/suite"
import { newValidityErrors, NOT_WELL_FORMED, opcSchemasMissing, schemaFamily, XsdOracle, xsdOracleMissing } from "./oracles/xsd"
import { applyShapeAndSlideEdits, openDeck, save } from "./pptxWriteFixtures"
import { budget } from "./timing"

// Every part a pptx save writes that an ECMA-376 schema declares (PresentationML, DrawingML, OPC relationships and
// content types, document properties), validated by xmllint against the Transitional schemas after Markup
// Compatibility. New decks (the blank presentation and every theme variant) have no error at all; over the corpus, a
// splice save of the shape and slide edit set and a fresh rewrite may not add an error to any part over its source
// part. Runs where xmllint and the pinned schemas exist (oracles/xsd.ts says how to fetch them).

const MISSING = xsdOracleMissing()
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "corpus", "manifest.json"), "utf8")) as CorpusManifest
const PRESENT = manifest.files.filter(
	file => /^(pptx|pptm|potx|potm|ppsx|ppsm)\//u.test(file.path) && file.password === undefined && existsSync(join(CORPUS_DIR, file.path))
)

const PML = "application/vnd.openxmlformats-officedocument.presentationml."
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const P14 = 'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"'
const TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>'

// A rewritten part is judged against the source part of its name. A part the source does not have under its name (a
// duplicated slide and its chart copies, a fresh rewrite's renumbered parts) against the whole source deck: it may not
// have more of an error than all the deck's source parts together.
interface Pending {
	readonly label: string
	// "<deck>\0<part>": a source part, or a written part judged against it.
	readonly key: string | undefined
	readonly deck: string | undefined
	readonly bytes: Uint8Array
	readonly source: boolean
	readonly reread: (() => Promise<Uint8Array>) | undefined
}

// Validates the schema-declared parts of source decks and saves in batches: one xmllint run per batch.
class Checker {
	readonly byKind: Record<string, number> = {}
	readonly failures: string[] = []
	private readonly sources = new Map<string, Map<string, number>>()
	private readonly decks = new Map<string, string[]>()
	private readonly totals = new Map<string, Map<string, number>>()
	private pending: Pending[] = []
	private pendingBytes = 0
	private readonly oracle: XsdOracle

	constructor(oracle: XsdOracle) {
		this.oracle = oracle
	}

	// Queues every schema-declared part of a source deck as the baseline of its saves.
	async source(name: string, pkg: OpcPackage): Promise<void> {
		const keys: string[] = []

		for (const part of await this.declared(pkg)) {
			const key = `${name}\0${part}`

			keys.push(key)
			this.push({ label: key, key, deck: name, bytes: await pkg.read(part), source: true, reread: undefined })
		}

		this.decks.set(name, keys)
		await this.maybeFlush()
	}

	// `parts`: the parts to judge (all of them when undefined). `deck`: the source deck registered with source(); without
	// one, no error is allowed. `sameNames`: a part keeps its source part's name and content (a splice save).
	async add(
		label: string,
		bytes: Uint8Array,
		deck?: { readonly name: string; readonly pkg: OpcPackage; readonly sameNames: boolean },
		parts?: readonly string[]
	): Promise<void> {
		const written = await OpcPackage.open(bytesSource(bytes))
		const judged = await this.declared(written, parts)
		const types = await written.contentTypes()

		for (const part of judged) {
			const type = part === "[Content_Types].xml" ? "contentTypes" : (types.typeOf(part) ?? "")
			const kind = `${schemaFamily(part, types.typeOf(part)) ?? ""}:${type.replace(/^.*[./]([\w-]+)\+xml$/, "$1")}`
			const same = deck !== undefined && deck.sameNames && deck.pkg.has(part)

			this.byKind[kind] = (this.byKind[kind] ?? 0) + 1
			this.push({
				label: `${label} ${part}`,
				key: same ? `${deck.name}\0${part}` : undefined,
				deck: deck?.name,
				bytes: await written.read(part),
				source: false,
				reread: same ? () => deck.pkg.read(part) : undefined
			})
		}

		await this.maybeFlush()
	}

	async flush(): Promise<void> {
		const batch = this.pending

		this.pending = []
		this.pendingBytes = 0

		const results = this.oracle.validate(batch.map(item => item.bytes))

		batch.forEach((item, index) => {
			if (item.source && item.key !== undefined) this.sources.set(item.key, results[index] as Map<string, number>)
		})

		for (const [index, item] of batch.entries()) {
			if (item.source) continue

			const after = results[index] as Map<string, number>
			const before = (item.key === undefined ? this.total(item.deck) : this.sources.get(item.key)) ?? new Map<string, number>()
			let failures = newValidityErrors(before, after)

			if (failures.length > 0 && item.reread !== undefined) failures = newValidityErrors(before, after, await item.reread())

			for (const failure of failures) this.failures.push(`${item.label}: ${failure}`)
		}
	}

	private async declared(pkg: OpcPackage, parts?: readonly string[]): Promise<string[]> {
		const types = await pkg.contentTypes()

		return (parts ?? pkg.zip.entries.filter(entry => !entry.name.endsWith("/")).map(entry => entry.name)).filter(part => {
			const family = schemaFamily(part, part === "[Content_Types].xml" ? undefined : types.typeOf(part))

			return family !== undefined && (family !== "opc" || this.oracle.opc)
		})
	}

	// Every source part's errors of a deck, summed.
	private total(deck: string | undefined): Map<string, number> | undefined {
		if (deck === undefined) return undefined

		let total = this.totals.get(deck)

		if (total === undefined) {
			total = new Map()
			for (const key of this.decks.get(deck) ?? [])
				for (const [message, count] of this.sources.get(key) ?? []) total.set(message, (total.get(message) ?? 0) + count)
			this.totals.set(deck, total)
		}

		return total
	}

	private push(item: Pending): void {
		this.pending.push(item)
		this.pendingBytes += item.bytes.length
	}

	private async maybeFlush(): Promise<void> {
		if (this.pending.length >= 400 || this.pendingBytes >= 64 << 20) await this.flush()
	}
}

describe("schema families of PresentationML parts", () => {
	it("maps the ECMA PresentationML parts to pml and leaves PowerPoint's own parts out", () => {
		for (const kind of ["presentation.main", "slide", "slideLayout", "slideMaster", "notesSlide", "notesMaster", "handoutMaster"])
			expect(schemaFamily(`ppt/${kind}.xml`, `${PML}${kind}+xml`)).toBe("pml")
		for (const kind of [
			"slideshow.main",
			"template.main",
			"comments",
			"commentAuthors",
			"presProps",
			"viewProps",
			"tableStyles",
			"tags"
		])
			expect(schemaFamily(`ppt/${kind}.xml`, `${PML}${kind}+xml`)).toBe("pml")
		expect(schemaFamily("ppt/slideUpdateInfo.xml", `${PML}slideUpdateInfo+xml`)).toBe("pml")
		for (const kind of ["presentation", "slideshow", "template", "addin"])
			expect(schemaFamily("ppt/presentation.xml", `application/vnd.ms-powerpoint.${kind}.macroEnabled.main+xml`)).toBe("pml")
		// Modern comments and their authors: Microsoft roots, left to the Open XML SDK validator.
		expect(schemaFamily("ppt/comments/modernComment_1.xml", "application/vnd.ms-powerpoint.comments+xml")).toBeUndefined()
		expect(schemaFamily("ppt/authors.xml", "application/vnd.ms-powerpoint.authors+xml")).toBeUndefined()
		expect(schemaFamily("ppt/slides/slide1.bin", `${PML}slide`)).toBeUndefined()
	})
})

describe.skipIf(MISSING !== undefined)("written presentations against the ECMA-376 schemas", () => {
	let oracle: XsdOracle

	beforeAll(() => {
		oracle = new XsdOracle()

		const opc = opcSchemasMissing()

		if (opc !== undefined) console.warn(`schema: OPC parts not validated: ${opc}`)
	})

	afterAll(() => {
		oracle.dispose()
	})

	it("reports what it should", { timeout: 60_000 }, () => {
		const documents = [
			`<p:sld ${P} ${A}><p:cSld>${TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
			// Child order: the colour map override before the common slide data.
			`<p:sld ${P} ${A}><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:cSld>${TREE}</p:cSld></p:sld>`,
			// Extension content is lax: a p14 element inside p:ext is no error; the bogus element after it is.
			`<p:sld ${P} ${A} ${P14}><p:cSld>${TREE}</p:cSld><p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><p14:creationId val="1"/></p:ext></p:extLst><p:bogus/></p:sld>`,
			`<p:presentation ${P}><p:sldSz cx="1" cy="1"/></p:presentation>`,
			`<p:sld ${P}><p:cSld>`
		]
		const results = oracle.validate(documents.map(encodeUtf8)).map(errors => [...errors.keys()].join(" | "))

		expect(results[0]).toBe("")
		expect(results[1]).toMatch(/\}clrMapOvr': This element is not expected/)
		expect(results[2]).toMatch(/\}bogus': This element is not expected/)
		expect(results[2]).not.toMatch(/creationId|p14/)
		expect(results[3]).toMatch(/\}sldSz'.*\[facet 'minInclusive'\]|\}notesSz'/)
		expect(results[4]).toBe(NOT_WELL_FORMED)
	})

	it(
		"finds no error in the blank presentation and every theme variant, as written and rewritten",
		{ timeout: budget(120_000) },
		async () => {
			const checker = new Checker(oracle)
			const decks: [string, Uint8Array][] = [["blank", await blankPptx({ locale: "en-GB" })]]

			for (const theme of FILEN_THEMES)
				for (const variant of [0, 1, 2, 3])
					decks.push([`${theme.id}-${String(variant)}`, await blankPptx({ theme, variant, title: theme.id })])

			for (const [name, bytes] of decks) {
				await checker.add(name, bytes)

				const opened = await openDeck(bytes)
				const sink = memorySink()
				const outcome = await freshPptx(opened.deck, opened.source, sink, {})

				if (outcome.kind !== "written") throw new Error(`${name}: ${outcome.kind}`)

				await checker.add(`${name} fresh`, sink.bytes())
			}

			await checker.flush()
			expect(checker.failures).toEqual([])
			expect(checker.byKind["pml:slideLayout"] ?? 0).toBeGreaterThanOrEqual(decks.length * 11 * 2)
		}
	)

	it.skipIf(PRESENT.length === 0)(
		"adds no validity errors to the parts an edited splice save and a fresh rewrite write",
		{ timeout: budget(1_800_000) },
		async () => {
			const checker = new Checker(oracle)
			let saves = 0

			for (const file of PRESENT) {
				const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, file.path)))
				const pkg = await OpcPackage.open(bytesSource(bytes))

				await checker.source(file.path, pkg)

				const opened = await openDeck(bytes)
				const sink = memorySink()
				const outcome = await freshPptx(opened.deck, opened.source, sink, {})

				if (outcome.kind === "written") {
					const out = sink.bytes()

					await checker.add(
						`${file.path} fresh`,
						out,
						{ name: file.path, pkg, sameNames: false },
						await changedParts(pkg, await OpcPackage.open(bytesSource(out)))
					)
					saves++
				}

				const edited = await openDeck(bytes)
				const { changes } = applyShapeAndSlideEdits(edited)
				const saved = await save(edited, changes)

				if (saved.outcome.kind === "written") {
					await checker.add(
						`${file.path} edited`,
						saved.bytes,
						{ name: file.path, pkg, sameNames: true },
						await changedParts(pkg, await OpcPackage.open(bytesSource(saved.bytes)))
					)
					saves++
				}
			}

			await checker.flush()
			console.log(`schema, pptx saves: ${String(saves)}, parts ${JSON.stringify(checker.byKind)}`)
			expect(checker.failures).toEqual([])
			expect(saves).toBeGreaterThanOrEqual(PRESENT.length)
		}
	)
})
