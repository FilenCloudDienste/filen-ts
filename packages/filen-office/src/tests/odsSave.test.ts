import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { openOds } from "../core/ods/open"
import type { SheetCommand } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { ODS_NS, odsBytes, odsDocument, shownRows, table, type OdsParts } from "./odsFixtures"
import { IMMEDIATE } from "./sheetSessionFixtures"
import { budget, cpuMs } from "./timing"
import { unzipSync, strFromU8 } from "fflate"
import { openingTag, printRanges, replaceAttribute, topElements } from "../core/ods/write/content"
import { paragraphs, whiteSpaceEdges } from "../core/ods/write/cells"

// Saving an OpenDocument spreadsheet: an untouched save is the source, an edit rewrites only what it changed, and
// every save reads back as the session shows it.

async function open(parts: OdsParts | Uint8Array) {
	const host = inThreadSheetHost()
	const bytes = parts instanceof Uint8Array ? parts : odsBytes(parts)
	const result = await host.open(
		bytes,
		{ kind: "ods", slicing: IMMEDIATE, settings: { clock: () => Date.UTC(2023, 2, 15, 12), author: "Test" } },
		() => undefined
	)

	if (result.kind !== "opened") throw new Error(result.kind === "failed" ? result.message : result.kind)

	const session = result.session
	const verdict = await session.intent()

	return { session, bytes, verdict, sheet: result.info.sheets[0]?.id ?? 0 }
}

function set(sheet: number, row: number, col: number, input: string): SheetCommand {
	return { type: "cells.set", sheet, cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(col), inputs: [input] } }
}

async function saved(session: Awaited<ReturnType<typeof open>>["session"]): Promise<Uint8Array> {
	const result = await session.save()

	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

	return result.bytes
}

async function rows(bytes: Uint8Array, sheet = 0): Promise<string[][]> {
	const opened = await openOds(bytesSource(bytes))

	if (!opened.ok) throw new Error(opened.message)

	const document = odsDocument(opened)

	await document.readyAllSheets()

	return shownRows(document, sheet)
}

function content(bytes: Uint8Array): string {
	return strFromU8(unzipSync(bytes)["content.xml"] ?? new Uint8Array(0))
}

const ROWS =
	'<table:table-column table:number-columns-repeated="3"/><table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>a</text:p></table:table-cell><table:table-cell table:formula="of:=[.A1]*2" office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="3"><table:table-cell office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/></table:table-row>'

describe("an ODS save", () => {
	it("is writable and saves untouched as the source's bytes", async () => {
		const { session, bytes, verdict } = await open({ body: table("One", "", ROWS) })

		expect(verdict.state).toBe("writable")
		expect(await saved(session)).toEqual(bytes)
		session.close()
	})

	it("writes an edited cell, copying the rows it left alone", async () => {
		const { session, sheet } = await open({ body: table("One", "", ROWS) })
		const result = await session.command(set(sheet, 0, 1, "hello"))

		expect(result.ok).toBe(true)

		const written = await saved(session)

		expect(await rows(written)).toEqual([["1", "hello", "2"], ["7"], ["7"], ["7"]])
		expect(content(written)).toContain(
			'<table:table-row table:number-rows-repeated="3"><table:table-cell office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/></table:table-row>'
		)
		session.close()
	})

	it("splits a repeated row an edit cut into", async () => {
		const { session, sheet } = await open({ body: table("One", "", ROWS) })

		await session.command(set(sheet, 2, 0, "8"))

		const written = await saved(session)

		expect(await rows(written)).toEqual([["1", "a", "2"], ["7"], ["8"], ["7"]])
		session.close()
	})

	it("recalculates and writes a formula's result and keeps its OpenFormula", async () => {
		const { session, sheet } = await open({ body: table("One", "", ROWS) })

		await session.command(set(sheet, 0, 0, "5"))

		const written = await saved(session)

		expect(await rows(written)).toEqual([["5", "a", "10"], ["7"], ["7"], ["7"]])
		expect(content(written)).toContain('table:formula="of:=[.A1]*2"')
		session.close()
	})

	it("marks an error result with LibreOffice's calcext only where the document already declares it", async () => {
		const strict = ODS_NS.split(" ")
			.filter(declaration => !declaration.startsWith("xmlns:calcext="))
			.join(" ")

		for (const [namespaces, marked] of [
			[ODS_NS, true],
			[strict, false]
		] as const) {
			const { session, sheet } = await open({ namespaces, body: table("One", "", ROWS) })

			await session.command(set(sheet, 1, 1, "=1/0"))

			const written = await saved(session)

			expect(content(written).includes('calcext:value-type="error"')).toBe(marked)
			expect((await rows(written))[1]).toEqual(["7", "#DIV/0!"])
			session.close()
		}
	})

	it("writes an error typed in a document without calcext as a formula of that error alone, reading back as it", async () => {
		const strict = ODS_NS.split(" ")
			.filter(declaration => !declaration.startsWith("xmlns:calcext="))
			.join(" ")
		const { session, sheet } = await open({ namespaces: strict, body: table("One", "", ROWS) })

		for (const [row, error] of ["#N/A", "#DIV/0!", "#NAME?", "#NUM!", "#REF!", "#VALUE!"].entries()) {
			expect((await session.command(set(sheet, 4 + row, 0, error))).ok).toBe(true)
		}

		const written = await saved(session)
		const xml = content(written)

		expect(xml).toContain('table:formula="of:=#N/A" office:value-type="float" office:value="0"><text:p>#N/A</text:p>')
		expect(xml).not.toContain("calcext:value-type")
		expect((await rows(written)).slice(4)).toEqual([["#N/A"], ["#DIV/0!"], ["#NAME?"], ["#NUM!"], ["#REF!"], ["#VALUE!"]])
		session.close()
	})

	it("refuses there #NULL!, which LibreOffice does not read back from its OpenFormula constant as the same error", async () => {
		const strict = ODS_NS.split(" ")
			.filter(declaration => !declaration.startsWith("xmlns:calcext="))
			.join(" ")
		const { session, sheet } = await open({ namespaces: strict, body: table("One", "", ROWS) })

		for (const error of ["#NULL!"]) {
			const result = await session.command(set(sheet, 1, 1, error))

			expect([error, result.ok ? null : result.refusal]).toEqual([error, { reason: "unsupported", detail: "errorValue" }])
		}

		expect(await saved(session)).toEqual(odsBytes({ namespaces: strict, body: table("One", "", ROWS) }))
		session.close()
	})

	it("keeps a frame anchored to a cell written again once, its image inside it", async () => {
		const frame =
			'<draw:frame draw:name="Image 1" svg:width="1cm" svg:height="1cm" svg:x="0cm" svg:y="0cm"><draw:image xlink:href="Pictures/a.png" xlink:type="simple"><text:p/></draw:image></draw:frame>'
		const { session, sheet } = await open({
			body: table(
				"One",
				`<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p>${frame}</table:table-cell></table:table-row>`
			)
		})

		await session.command(set(sheet, 0, 0, "2"))

		const xml = content(await saved(session))

		expect(xml).toContain(`<text:p>2</text:p>${frame}</table:table-cell>`)
		expect(xml.split("<draw:image").length - 1).toBe(1)
		session.close()
	})

	it("keeps a date cell's calendar date under any null date (ODF 1.3 Part 3 §19.379, §19.639)", async () => {
		const body =
			'<table:calculation-settings><table:null-date table:date-value="1900-01-01"/></table:calculation-settings>' +
			table(
				"One",
				'<table:table-row><table:table-cell office:value-type="date" office:date-value="2024-01-01"><text:p>2024-01-01</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>'
			)
		const { session, sheet } = await open({ body })

		// The date (45292 on the engine's 1899-12-30 base) shows in the standard date format: it has no data style.
		expect((await rows(odsBytes({ body })))[0]?.[0]).toBe("1/1/2024")

		await session.command(set(sheet, 0, 1, "2"))

		const unrelated = content(await saved(session))

		expect(unrelated).toContain('office:date-value="2024-01-01"')
		expect(unrelated).toContain('<table:null-date table:date-value="1900-01-01"/>')

		await session.command(set(sheet, 0, 0, "2024-02-01"))

		const typed = content(await saved(session))

		expect(typed).toContain('office:date-value="2024-02-01"')
		expect(typed).not.toContain('office:date-value="2024-01-01"')
		session.close()
	})
})

// ODF 1.3 Part 2 §3.8: the preview shows the document as it opens; a save that rewrites it cannot redraw it.
describe("an ODS save's preview image", () => {
	const THUMBNAIL = "Thumbnails/thumbnail.png"
	const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
	const withPreview = (parts: Partial<OdsParts> = {}): Uint8Array =>
		odsBytes({ body: table("One", "", ROWS), extra: [{ name: THUMBNAIL, data: PNG }], ...parts })
	const manifest = (bytes: Uint8Array): string => strFromU8(unzipSync(bytes)["META-INF/manifest.xml"] ?? new Uint8Array(0))

	it("is dropped with its manifest entry once a cell is edited", async () => {
		const { session, sheet } = await open(withPreview())

		await session.command(set(sheet, 0, 1, "hello"))

		const written = await saved(session)

		expect(Object.keys(unzipSync(written))).not.toContain(THUMBNAIL)
		expect(manifest(written)).not.toContain(THUMBNAIL)
		expect(manifest(written)).toContain('manifest:full-path="content.xml"')
		expect(await rows(written)).toEqual([["1", "hello", "2"], ["7"], ["7"], ["7"]])
		session.close()
	})

	it("is kept by a save that writes nothing new", async () => {
		const { session, sheet, bytes } = await open(withPreview())

		expect(await saved(session)).toEqual(bytes)

		await session.command(set(sheet, 0, 1, "hello"))
		await session.undo()

		const written = await saved(session)

		expect(unzipSync(written)[THUMBNAIL]).toEqual(PNG)
		expect(manifest(written)).toContain(THUMBNAIL)
		session.close()
	})

	it("is dropped while a new settings.xml is listed in the same manifest", async () => {
		const { session, sheet } = await open(withPreview())

		await session.command({ type: "view.freeze", sheet, rows: 2, cols: 0 })

		const written = await saved(session)
		const files = unzipSync(written)

		expect(Object.keys(files)).toContain("settings.xml")
		expect(Object.keys(files)).not.toContain(THUMBNAIL)
		expect(manifest(written)).toContain('manifest:full-path="settings.xml"')
		expect(manifest(written)).not.toContain(THUMBNAIL)
		session.close()
	})
})

describe("an ODS save of whole-column validations", () => {
	const RULE = (name: string, col: string): string =>
		`<table:content-validation table:name="${name}" table:condition="of:cell-content-is-in-list(&quot;Yes&quot;;&quot;No&quot;)" table:allow-empty-cell="true" table:base-cell-address="One.${col}1">` +
		'<table:help-message table:title="Pick" table:display="true"><text:p>yes or no</text:p></table:help-message></table:content-validation>'
	const NAMES = ["val1", "val2", "val3", "val4"]
	const RULES = `<table:content-validations>${NAMES.map((name, k) => RULE(name, String.fromCharCode(65 + k))).join("")}</table:content-validations>`
	const COLUMNS = `<table:table-row table:number-rows-repeated="1048576">${NAMES.map(name => `<table:table-cell table:content-validation-name="${name}"/>`).join("")}</table:table-row>`

	it("maps the rules through an inserted row by runs of rows, not one rectangle per row", async () => {
		const { session, sheet } = await open({ body: RULES + table("One", COLUMNS) })
		const started = cpuMs()

		expect((await session.command({ type: "axis.insert", sheet, axis: "rows", at: 2, count: 1 })).ok).toBe(true)

		const written = await saved(session)
		// One rectangle per row of each column was seconds of work and hundreds of MB.
		const spent = cpuMs() - started

		session.close()

		const back = await open(written)
		const layout = await back.session.layout(back.sheet)

		const quads = [...(layout.extensions?.validations?.ranges ?? [])]
		// Each column's rows covered, as [first, last] runs (quads are [startRow, startCol, endRow, endCol]).
		const covered = NAMES.map((_, col) => {
			const runs: [number, number][] = []

			for (let k = 0; k + 3 < quads.length; k += 4)
				if ((quads[k + 1] ?? 0) <= col && col <= (quads[k + 3] ?? 0)) runs.push([quads[k] ?? 0, quads[k + 2] ?? 0])

			return runs
				.sort((a, b) => a[0] - b[0])
				.reduce<[number, number][]>((out, run) => {
					const last = out[out.length - 1]

					if (last !== undefined && last[1] + 1 === run[0]) last[1] = run[1]
					else out.push(run)

					return out
				}, [])
		})

		// Every rule still covers its whole column, the inserted row with it.
		expect(covered).toEqual(NAMES.map(() => [[0, 1048575]]))
		expect(spent).toBeLessThan(budget(1000))
		back.session.close()
	})
})

// A start tag's attributes in either quote and with space around "=", and ">" inside a value (XML 1.0 §3.1).
describe("an ODS save's markup helpers", () => {
	it("replaces and removes an attribute in either quote, never one a value holds", () => {
		const tag = "<table:table table:name='Sheet 1' table:style-name = \"ta1\">"

		expect(replaceAttribute(tag, "table:name", "Two")).toBe('<table:table table:style-name = "ta1" table:name="Two">')
		expect(replaceAttribute(tag, "table:style-name", undefined)).toBe("<table:table table:name='Sheet 1'>")
		expect(replaceAttribute('<a x:t=\' table:name="q"\' table:name="n"/>', "table:name", "m")).toBe(
			'<a x:t=\' table:name="q"\' table:name="m"/>'
		)
		expect(replaceAttribute('<a b="1>2">', "c", "3")).toBe('<a b="1>2" c="3">')
	})

	it("splits markup into its elements past a > inside a value", () => {
		expect(topElements("<a x=\"1>2\"/><b y='>'><c/></b><!-- > --><d/>")).toEqual(['<a x="1>2"/>', "<b y='>'><c/></b>", "<d/>"])
		expect(openingTag("<b y='>'><c/></b>")).toBe("<b y='>'>")
	})

	it("writes print areas whose sheet names hold a comma, an apostrophe or a bang", () => {
		expect(printRanges("'Q1, Q2'!$A$1:$D$20", "Q1, Q2")).toBe("$'Q1, Q2'.$A$1:$'Q1, Q2'.$D$20")
		expect(printRanges("'It''s'!$A$1:$B$2,'It''s'!$C$3", "It's")).toBe("$'It''s'.$A$1:$'It''s'.$B$2 $'It''s'.$C$3")
		expect(printRanges("'a!b'!$A$1", "a!b")).toBe("$'a!b'.$A$1")
		expect(printRanges("$B$2:$C$3", "S")).toBe("$S.$B$2:$S.$C$3")
		expect(printRanges("S!$1:$5", "S")).toBeUndefined()
	})

	it("keeps a link's leading, trailing and only white space outside it, as the expression it replaced split it", () => {
		const old = (body: string): [string, string, string] => {
			const edges = /^((?:<text:(?:tab|s)\b[^>]*\/>)*)([\s\S]*?)((?:<text:(?:tab|s)\b[^>]*\/>)*)$/.exec(body)

			return [edges?.[1] ?? "", edges?.[2] ?? body, edges?.[3] ?? ""]
		}

		for (const body of [
			"x",
			"<text:tab/>x",
			'x<text:s text:c="2"/>',
			'<text:s/><text:tab/>a<text:tab/>b <text:s text:c="3"/>c<text:tab/><text:s/>',
			'<text:tab/><text:s text:c="4"/><text:tab/>',
			"<text:span>x</text:span><text:tab/>",
			"<text:soft-page-break/>x"
		])
			expect(whiteSpaceEdges(body)).toEqual(old(body))

		expect(paragraphs("\t\t", null, "https://example.com/")).toBe("<text:p><text:tab/><text:tab/></text:p>")
	})

	it("writes a linked cell of tens of thousands of tabs in linear time", () => {
		const text = `x${"\t".repeat(30_000)}y`
		let least = Infinity

		for (let round = 0; round < 3; round++) {
			const started = cpuMs()

			paragraphs(text, null, "https://example.com/")
			least = Math.min(least, cpuMs() - started)
		}

		expect(least).toBeLessThan(budget(50))
	})
})

describe("an ODS save of names and sheets as other producers write them", () => {
	it("renames a sheet whose table:name is single-quoted", async () => {
		const { session, sheet } = await open({ body: `<table:table table:name='Sheet 1'>${ROWS}</table:table>` })

		expect((await session.command({ type: "sheet.rename", sheet, name: "Renamed" })).ok).toBe(true)

		const written = await saved(session)
		const opened = await openOds(bytesSource(written))

		if (!opened.ok) throw new Error(opened.message)

		expect(opened.workbook.sheets.map(entry => entry.name)).toEqual(["Renamed"])
		expect(await rows(written)).toEqual([["1", "a", "2"], ["7"], ["7"], ["7"]])
		session.close()
	})

	it("keeps every name after a rename when the first one's expression holds a raw >", async () => {
		const names =
			'<table:named-expressions><table:named-expression table:name="Big" table:base-cell-address="$S.$A$1" table:expression="of:=[$S.$A$1]>5"/>' +
			'<table:named-range table:name="Far" table:base-cell-address="$S.$A$1" table:cell-range-address="$S.$A$2"/></table:named-expressions>'
		const { session, sheet } = await open({ body: table("S", ROWS) + names })

		expect((await session.command({ type: "sheet.rename", sheet, name: "Data" })).ok).toBe(true)

		const written = await saved(session)
		const opened = await openOds(bytesSource(written))

		if (!opened.ok) throw new Error(opened.message)

		expect(opened.workbook.definedNames.map(name => [name.name, name.formula])).toEqual([
			["Big", "Data!$A$1>5"],
			["Far", "Data!$A$2"]
		])
		session.close()
	})

	it("accepts a name edit on a workbook whose print area is on a sheet named with a comma", async () => {
		const result = await inThreadSheetHost().open(
			odsBytes({ body: table("Q1, Q2", ROWS, "", " table:print-ranges=\"$'Q1, Q2'.$A$1:$'Q1, Q2'.$C$4\"") + table("Other", ROWS) }),
			{ kind: "ods", slicing: IMMEDIATE, settings: { author: "Test" } },
			() => undefined
		)

		if (result.kind !== "opened") throw new Error(result.kind)

		const session = result.session
		const other = result.info.sheets[1]?.id ?? 1

		expect((await session.intent()).state).toBe("writable")
		expect((await session.command({ type: "sheet.rename", sheet: other, name: "Next" })).ok).toBe(true)

		const written = await saved(session)

		expect(content(written)).toContain("table:print-ranges=\"$'Q1, Q2'.$A$1:$'Q1, Q2'.$C$4\"")
		session.close()
	})
})

// The writer matches elements by their conventional prefixes: a document binding the table namespace otherwise opens
// but is not saved, at the root or in an element's own scope; one that lacks LibreOffice's own namespaces is.
describe("an ODS save under other prefixes", () => {
	const TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"

	it("is refused at open for a table namespace bound to another prefix, at the root or below it", async () => {
		const root = await open({
			namespaces: `${ODS_NS} xmlns:t="${TABLE}"`,
			body: '<t:table t:name="S"><t:table-row><t:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></t:table-cell></t:table-row></t:table>'
		})

		expect(root.verdict).toEqual({ state: "viewOnly", reason: "lossy" })
		root.session.close()

		const below = await open({
			body: table(
				"S",
				`<table:table-row><x:table-cell xmlns:x="${TABLE}" office:value-type="float" office:value="1"><text:p>1</text:p></x:table-cell></table:table-row>`
			)
		})

		expect(below.verdict).toEqual({ state: "viewOnly", reason: "lossy" })
		below.session.close()
	})

	it("stays editable and saves without calcext, loext and of declared", async () => {
		const namespaces = ODS_NS.split(" ")
			.filter(declaration => !/^xmlns:(?:calcext|loext|of)=/.test(declaration))
			.join(" ")
		const { session, sheet, verdict } = await open({ namespaces, body: table("One", ROWS) })

		expect(verdict.state).toBe("writable")
		expect((await session.command(set(sheet, 0, 1, "hello"))).ok).toBe(true)
		expect(await rows(await saved(session))).toEqual([["1", "hello", "2"], ["7"], ["7"], ["7"]])
		session.close()
	})
})

describe("an ODS save of changed rows over a tall sheet", () => {
	// Each source row element looked at the rows a merge changed: tens of thousands of each were seconds of work.
	it("writes a tall new merge over tens of thousands of distinct rows quickly", async () => {
		const distinct = Array.from(
			{ length: 20_000 },
			(_, row) =>
				`<table:table-row><table:table-cell office:value-type="float" office:value="${row}"><text:p>${row}</text:p></table:table-cell></table:table-row>`
		).join("")
		const { session, sheet } = await open({ body: table("One", distinct) })
		const started = cpuMs()

		expect(
			(
				await session.command({
					type: "merge.cells",
					sheet,
					ranges: [{ startRow: 0, startCol: 1, endRow: 59_999, endCol: 1 }],
					mode: "merge"
				})
			).ok
		).toBe(true)

		const written = await saved(session)
		const spent = cpuMs() - started
		const back = await open(written)

		expect((await rows(written)).slice(19_998)).toEqual([["19998"], ["19999"]])
		expect([...(await back.session.layout(back.sheet)).merges]).toEqual([0, 1, 59_999, 1])
		expect(spent).toBeLessThan(budget(2500))
		back.session.close()
		session.close()
	}, 60_000)
})

describe("an ODS save of a block of linked cells", () => {
	it("keeps the links of a repeated linked cell after a row insert", async () => {
		const { session, sheet } = await open({
			body: table(
				"S",
				'<table:table-row table:number-rows-repeated="3"><table:table-cell table:number-columns-repeated="2" office:value-type="string"><text:p><text:a xlink:href="https://example.com/">x</text:a></text:p></table:table-cell></table:table-row>'
			)
		})

		expect((await session.command({ type: "axis.insert", sheet, axis: "rows", at: 1, count: 1 })).ok).toBe(true)

		const back = await open(await saved(session))
		const links: (string | null)[] = []

		for (let row = 0; row < 4; row++)
			for (let col = 0; col < 2; col++)
				links.push((await back.session.query("link.get", { sheet: back.sheet, row, col }))?.url ?? null)

		const url = "https://example.com/"

		expect(links).toEqual([url, url, null, null, url, url, url, url])
		back.session.close()
		session.close()
	})
})
