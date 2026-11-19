import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"
import { convertText } from "../core/convert/text/index"
import { standaloneParts } from "../core/convert/text/odtPackage"
import { LossyCounts } from "../core/convert/text/report"
import { ByteKeyMap } from "../core/odt/write/byteKeys"
import { OdfEmitter, OdtWriteRefusal } from "../core/odt/write/emit"
import { bytesSource, ZipArchive } from "../core/opc/index"
import { assertWellFormed, decodeUtf8, encodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"
import { buildDocx, p, type SyntheticDocx } from "./docxSynthetic"
import { odtBytes } from "./odtFixtures"
import { buildZip, text } from "./zipBuilder"
import { budget } from "./timing"

const cell = (tcPr: string, text = "c"): string => `<w:tc><w:tcPr>${tcPr}</w:tcPr>${p(text)}</w:tc>`
const table = (rows: string): string => `<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid>${rows}</w:tbl>${p("after")}`

async function content(spec: SyntheticDocx): Promise<string> {
	const converted = await convertText(buildDocx(spec), "docx", "odt")

	if (!converted.ok) throw new Error(converted.refusal.message)

	const archive = await ZipArchive.open(bytesSource(converted.bytes))
	const entry = archive.entries.find(item => item.name === "content.xml")

	return entry === undefined ? "" : decodeUtf8(await archive.read(entry))
}

const count = (text: string, part: string): number => text.split(part).length - 1

async function refusal(spec: SyntheticDocx): Promise<string> {
	const converted = await convertText(buildDocx(spec), "docx", "odt")

	return converted.ok ? "ok" : converted.refusal.reason
}

describe("docx → odt on hostile sizes", () => {
	// WordprocessingML sets no column limit: a row past 1024 columns is refused as hostile, before it is laid out.
	it("refuses a row past 1024 grid columns before laying it out", { timeout: 10_000 }, async () => {
		const started = performance.now()

		expect(await refusal({ body: table(`<w:tr><w:trPr><w:gridBefore w:val="1000000000"/></w:trPr>${cell("")}</w:tr>`) })).toBe(
			"tooLarge"
		)
		expect(await refusal({ body: table(`<w:tr><w:trPr><w:gridAfter w:val="Infinity"/></w:trPr>${cell("")}</w:tr>`) })).toBe("tooLarge")
		expect(await refusal({ body: table(`<w:tr>${cell('<w:gridSpan w:val="5000000"/>')}</w:tr><w:tr>${cell("")}</w:tr>`) })).toBe(
			"tooLarge"
		)
		expect(await refusal({ body: table(`<w:tr>${cell('<w:gridSpan w:val="1000"/>').repeat(2)}</w:tr>`) })).toBe("tooLarge")
		// A row inside a content control counts too.
		expect(
			await refusal({
				body: table(`<w:sdt><w:sdtContent><w:tr>${cell('<w:gridSpan w:val="400000000"/>')}</w:tr></w:sdtContent></w:sdt>`)
			})
		).toBe("tooLarge")
		expect(performance.now() - started).toBeLessThan(budget(5000))
	})

	it("converts wide tables: 63 columns as a table, 64 and 1024 in the plain fallback", async () => {
		const wide = (n: number): string =>
			`<w:tbl><w:tblGrid>${'<w:gridCol w:w="150"/>'.repeat(n)}</w:tblGrid><w:tr>${Array.from({ length: n }, (_, k) => cell("", `C${String(k)}`)).join("")}</w:tr></w:tbl>${p("after")}`

		for (const n of [63, 64, 100, 1024]) {
			const converted = await convertText(buildDocx({ body: wide(n) }), "docx", "odt")

			if (!converted.ok) throw new Error(converted.refusal.message)

			const archive = await ZipArchive.open(bytesSource(converted.bytes))
			const entry = archive.get("content.xml")
			const written = entry === undefined ? "" : decodeUtf8(await archive.read(entry))

			expect(count(written, `>C${String(n - 1)}<`)).toBe(1)
			expect(converted.lossy.features.some(feature => feature.kind === "blockFormat")).toBe(n > 63)
		}
	})

	it("writes a grid wider than its rows no wider than they are", { timeout: 20_000 }, async () => {
		const grid = (n: number): string => `<w:tblGrid>${'<w:gridCol w:w="150"/>'.repeat(n)}</w:tblGrid>`
		const narrow = `<w:tbl>${grid(10_000)}${`<w:tr>${cell("")}</w:tr>`.repeat(2000)}</w:tbl>${p("after")}`
		const written = await content({ body: narrow.repeat(4) })

		expect(written.length).toBeLessThan(2_000_000)
	})

	it("writes a long table a few rows at a time as one table: spans down across them, header rows, a refused row", async () => {
		const rows: string[] = []

		for (let k = 0; k < 600; k++) {
			const merge = k === 250 ? '<w:vMerge w:val="restart"/>' : k > 250 && k < 300 ? "<w:vMerge/>" : ""
			const header = k < 2 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""

			rows.push(
				`<w:tr>${header}<w:tc><w:tcPr>${merge}</w:tcPr>${merge === "<w:vMerge/>" ? "<w:p/>" : k === 400 ? p("A400") : p(`A${String(k)}`)}</w:tc>${cell("", `B${String(k)}`)}</w:tr>`
			)
		}

		// A cell the emitter cannot write (the lowering leaves none in a .docx): its row is written with its text only.
		type CellMarkup = (
			document: XmlDocument,
			cell: number,
			style: string,
			span: number,
			rows: number,
			slot?: (at: number) => void
		) => string
		const emitter = OdfEmitter.prototype as unknown as { cellMarkup: CellMarkup }
		const cellMarkup = emitter.cellMarkup
		const spy = vi.spyOn(emitter, "cellMarkup").mockImplementation(function (
			this: OdfEmitter,
			document,
			cell,
			style,
			span,
			spanned,
			slot
		) {
			if (document.textContent(cell) === "A400") throw new OdtWriteRefusal("table", "a cell")

			return cellMarkup.call(this, document, cell, style, span, spanned, slot)
		})
		let converted: Awaited<ReturnType<typeof convertText>>

		try {
			converted = await convertText(
				buildDocx({ body: `<w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${rows.join("")}</w:tbl>` }),
				"docx",
				"odt"
			)
		} finally {
			spy.mockRestore()
		}

		if (!converted.ok) throw new Error(converted.refusal.message)

		const archive = await ZipArchive.open(bytesSource(converted.bytes))
		const entry = archive.get("content.xml")
		const written = entry === undefined ? "" : decodeUtf8(await archive.read(entry))

		expect(count(written, "<table:table ")).toBe(1)
		expect(count(written, "<table:table-row")).toBe(600)
		expect(count(written, "<table:table-header-rows>")).toBe(1)
		expect(written).toMatch(
			/<table:table-header-rows>(?:<table:table-row(?:(?!table-row>).)*<\/table:table-row>){2}<\/table:table-header-rows>/u
		)
		expect(written).toMatch(/table:number-rows-spanned="50"[^>]*><text:p[^>]*>A250</u)
		expect(written).not.toContain('rows-spanned="@')
		expect(count(written, ">B599<")).toBe(1)
		expect(written).toContain(">A400<")
		expect(converted.lossy.features).toContainEqual({ kind: "blockFormat", count: 1 })
	})

	it("keeps cell text that reads like a span placeholder in a long table, and every span", async () => {
		const RESTART = '<w:vMerge w:val="restart"/>'
		const tc = (text: string, tcPr = ""): string =>
			`<w:tc>${tcPr === "" ? "" : `<w:tcPr>${tcPr}</w:tcPr>`}${text.startsWith("<") ? text : p(text)}</w:tc>`
		// Spans: column 1 rows 5–290, column 0 rows 20–30.
		const spanned = (r: number, c: number): string =>
			c === 1 && r >= 5 && r <= 290
				? tc(r === 5 ? "S1-5" : "", r === 5 ? RESTART : "<w:vMerge/>")
				: c === 0 && r >= 20 && r <= 30
					? tc(r === 20 ? "S0-20" : "", r === 20 ? RESTART : "<w:vMerge/>")
					: tc(`r${String(r)}c${String(c)}`)
		let rows = ""

		for (let r = 0; r < 300; r++) {
			let cells = ""

			for (let c = 0; c < 3; c++)
				cells +=
					r === 10 && c === 0
						? tc('x table:number-rows-spanned="@0" y')
						: r === 11 && c === 2
							? tc(
									'<w:p><w:hyperlink r:id="rIdL"><w:r><w:t>a table:number-rows-spanned="@1" b</w:t></w:r></w:hyperlink></w:p>'
								)
							: spanned(r, c)

			rows += `<w:tr>${cells}</w:tr>`
		}

		const written = await content({
			body: `<w:tbl><w:tblGrid>${'<w:gridCol w:w="1500"/>'.repeat(3)}</w:tblGrid>${rows}</w:tbl>`,
			relationships: [{ id: "rIdL", type: "hyperlink", target: 'https://x.y/? table:number-rows-spanned="@1"', external: true }]
		})

		expect(written).toContain('x table:number-rows-spanned="@0" y')
		expect(written).toContain('a table:number-rows-spanned="@1" b')
		expect(written).toMatch(/table:number-rows-spanned="286"[^>]*><text:p[^>]*>S1-5</u)
		expect(written).toMatch(/table:number-rows-spanned="11"[^>]*><text:p[^>]*>S0-20</u)
	})

	it("refuses tables past two million cells before lowering their rows", { timeout: 20_000 }, async () => {
		const started = performance.now()
		const rows = `<w:tr><w:trPr><w:gridBefore w:val="1023"/></w:trPr>${cell("")}</w:tr>`.repeat(2000)

		expect(await refusal({ body: table(rows) })).toBe("tooLarge")
		expect(performance.now() - started).toBeLessThan(budget(10_000))
	})

	it("writes a note referenced many times once, later references as note references to it", { timeout: 20_000 }, async () => {
		const written = await content({
			body: `<w:p>${'<w:r><w:footnoteReference w:id="1"/></w:r>'.repeat(2000)}</w:p>`,
			footnotes: `<w:footnote w:id="1"><w:p><w:r><w:t>${"note text ".repeat(5000)}</w:t></w:r></w:p></w:footnote>`
		})

		expect(count(written, "note text note text")).toBeGreaterThan(0)
		expect(count(written, "<text:note ")).toBe(1)
		expect(count(written, 'text:id="filen-footnote-1"')).toBe(1)
		expect(
			count(
				written,
				'<text:note-ref text:note-class="footnote" text:reference-format="text" text:ref-name="filen-footnote-1">1</text:note-ref>'
			)
		).toBe(1999)
		expect(written.length).toBeLessThan(400_000)
	})

	it("writes every level of a chain of notes, a nested custom mark with its note", async () => {
		const ref = (id: string, custom = ""): string =>
			`<w:r><w:footnoteReference${custom === "" ? "" : ' w:customMarkFollows="1"'} w:id="${id}"/>${custom === "" ? "" : `<w:t>${custom}</w:t>`}</w:r>`
		const note = (id: string, text: string, after = ""): string =>
			`<w:footnote w:id="${id}"><w:p><w:r><w:t>${text}</w:t></w:r>${after}</w:p></w:footnote>`
		const deep = await content({
			body: `<w:p>${ref("1")}</w:p>`,
			footnotes: Array.from({ length: 10 }, (_, k) => note(String(k + 1), `N${String(k + 1)}`, k < 9 ? ref(String(k + 2)) : "")).join(
				""
			)
		})

		expect(deep).toContain("N1 (N2 (N3 (N4 (N5 (N6 (N7 (N8 (N9 (N10)))))))))")

		const custom = await content({ body: `<w:p>${ref("1")}</w:p>`, footnotes: note("1", "F", ref("2", "*")) + note("2", "Starred") })

		expect(custom).toContain("F (* Starred)")

		const converted = await convertText(
			buildDocx({
				body: `<w:p>${ref("1")}</w:p>`,
				footnotes: Array.from({ length: 40 }, (_, k) =>
					note(String(k + 1), `N${String(k + 1)}`, k < 39 ? ref(String(k + 2)) : "")
				).join("")
			}),
			"docx",
			"odt"
		)

		if (!converted.ok) throw new Error(converted.refusal.message)

		// 39 references in notes, and once more for the levels past the 16 written (left out).
		expect(converted.lossy.features).toContainEqual({ kind: "nestedNote", count: 40 })
	})

	it("writes a note referenced in a header as its text there, and counts it", async () => {
		const spec: SyntheticDocx = {
			body: '<w:p><w:r><w:footnoteReference w:id="1"/></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
			headers: { rIdH: '<w:p><w:r><w:t>H</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>' },
			footnotes: '<w:footnote w:id="1"><w:p><w:r><w:t>HeaderNote</w:t></w:r></w:p></w:footnote>'
		}
		const converted = await convertText(buildDocx(spec), "docx", "odt")

		if (!converted.ok) throw new Error(converted.refusal.message)

		const archive = await ZipArchive.open(bytesSource(converted.bytes))
		const entry = archive.get("styles.xml")
		const styles = entry === undefined ? "" : decodeUtf8(await archive.read(entry))

		expect(styles).toMatch(/<style:header>.*H \(HeaderNote\).*<\/style:header>/u)
		expect(styles).not.toMatch(/<text:note[\s>]/u)
		expect(converted.lossy.features.some(feature => feature.kind === "nestedNote")).toBe(true)
	})

	it("writes a note referenced inside a note as its text there, and counts it", async () => {
		const chain =
			'<w:footnote w:id="1"><w:p><w:r><w:t>One</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Two</w:t></w:r></w:p></w:footnote>'
		const mutual =
			'<w:footnote w:id="1"><w:p><w:r><w:t>One</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Two</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p></w:footnote>'
		const self = '<w:footnote w:id="1"><w:p><w:r><w:t>One</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p></w:footnote>'

		for (const footnotes of [chain, mutual, self]) {
			const spec = { body: '<w:p><w:r><w:t>B</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>', footnotes }
			const converted = await convertText(buildDocx(spec), "docx", "odt")

			if (!converted.ok) throw new Error(converted.refusal.message)

			const written = await content(spec)

			expect(count(written, "<text:note ")).toBe(1)
			expect(written).not.toContain("<text:note-ref")
			expect(written).toMatch(/<text:note-body><text:p[^>]*>One(?: \(Two\))?<\/text:p><\/text:note-body>/u)
			expect(converted.lossy.features.some(feature => feature.kind === "nestedNote")).toBe(true)
		}
	})
})

describe("docx → odt note marks", () => {
	const note = '<w:footnote w:id="1"><w:p><w:r><w:t>STARNOTE</w:t></w:r></w:p></w:footnote>'
	// As LibreOffice reads Word's custom mark: the citation's label, the text after it the body's.
	const marked = '<text:note-citation text:label="*">*</text:note-citation>'

	it("takes a custom mark from the reference's own run, the next run's text after the note", async () => {
		const written = await content({
			body: '<w:p><w:r><w:t>Body</w:t></w:r><w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/><w:t>*</w:t></w:r><w:r><w:t xml:space="preserve"> AFTERRUN</w:t></w:r></w:p>',
			footnotes: note
		})

		expect(written).toContain(marked)
		expect(written).toMatch(/<\/text:note>(?:<text:span[^>]*>)?(?:<text:s\/>| )AFTERRUN/u)
		expect(count(written, "AFTERRUN")).toBe(1)
	})

	it("takes a custom mark alone in its run", async () => {
		const written = await content({
			body: '<w:p><w:r><w:t>Body</w:t></w:r><w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/><w:t>*</w:t></w:r></w:p>',
			footnotes: note
		})

		expect(written).toContain(marked)
	})

	it("keeps a tab in a custom mark, as LibreOffice does", async () => {
		const written = await content({
			body: '<w:p><w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/><w:tab/><w:t>X</w:t></w:r></w:p>',
			footnotes: note
		})

		expect(written).toContain('<text:note-citation text:label="&#9;X">')
	})

	it("numbers a note whose custom mark is empty, as LibreOffice does", async () => {
		for (const body of [
			'<w:p><w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/></w:r></w:p>',
			'<w:p><w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/></w:r><w:hyperlink w:anchor="x"><w:r><w:t>LINK</w:t></w:r></w:hyperlink></w:p>'
		]) {
			const written = await content({ body, footnotes: note })

			expect(written).toMatch(/<text:note [^>]*><text:note-citation>(?:1)?<\/text:note-citation>/u)
			expect(written).not.toContain("text:label")
		}
	})

	it("takes a custom mark from the next run once", async () => {
		const written = await content({
			body: '<w:p><w:r><w:t>Body</w:t></w:r><w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/></w:r><w:r><w:t>*</w:t></w:r><w:r><w:t xml:space="preserve"> AFTERRUN</w:t></w:r></w:p>',
			footnotes: note
		})

		expect(written).toContain(marked)
		expect(count(written, "*")).toBe(2)
		expect(count(written, "AFTERRUN")).toBe(1)
	})
})

describe("byte-keyed caches on crafted keys", () => {
	const fnv = (state: number, bytes: Uint8Array): number => {
		let h = state

		for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193)

		return h >>> 0
	}
	const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

	// Two printable 6-byte blocks hashing alike from FNV-1a state `state` (a birthday search).
	function pair(state: number, seed: number): [Uint8Array, Uint8Array, number] {
		const seen = new Map<number, Uint8Array>()
		let x = seed

		for (;;) {
			const block = new Uint8Array(6)

			for (let k = 0; k < 6; k++) {
				x = (Math.imul(x, 1103515245) + 12345) >>> 0
				block[k] = ALPHA.charCodeAt((x >>> 16) % ALPHA.length)
			}

			const out = fnv(state, block)
			const other = seen.get(out)

			if (other !== undefined && other.join() !== block.join()) return [other, block, out]

			seen.set(out, block)
		}
	}

	it("stays linear on keys built to collide under plain FNV-1a", { timeout: 30_000 }, () => {
		// 2^12 distinct keys one hash under an unseeded FNV-1a (a Joux multicollision of 12 stages).
		const prefix = new TextEncoder().encode(`<w:rPr w:x="${"p".repeat(2000)}`)
		const stages: [Uint8Array, Uint8Array][] = []
		let state = fnv(0x811c9dc5, prefix)

		for (let stage = 0; stage < 12; stage++) {
			const [a, b, next] = pair(state, stage * 7919 + 1)

			stages.push([a, b])
			state = next
		}

		const keys = Array.from({ length: 1 << 12 }, (_, m) => {
			const key = new Uint8Array(prefix.length + 72)

			key.set(prefix)
			stages.forEach(([a, b], stage) => key.set((m >> stage) & 1 ? b : a, prefix.length + stage * 6))

			return key
		})
		const map = new ByteKeyMap<number>(4096)
		const started = performance.now()

		for (let round = 0; round < 3; round++) for (const key of keys) if (map.get(key) === undefined) map.set(key, 1)

		expect(performance.now() - started).toBeLessThan(budget(3000))
	})
})

describe("docx → odt memory", () => {
	it("lets each lowered run of blocks go once written", { timeout: 60_000 }, async () => {
		setFlagsFromString("--expose-gc")

		const gc = runInNewContext("gc") as () => void
		// The emitters are kept: what they hold stays reachable, what only the converter held does not.
		const emitters = new Set<OdfEmitter>()
		const seen = new Set<XmlDocument>()
		let collected = 0
		const registry = new FinalizationRegistry<undefined>(() => collected++)
		const blocks = OdfEmitter.prototype.blocks
		const spy = vi.spyOn(OdfEmitter.prototype, "blocks").mockImplementation(function (this: OdfEmitter, document, nodes) {
			emitters.add(this)

			if (!seen.has(document)) {
				seen.clear()
				seen.add(document)
				registry.register(document, undefined)
			}

			return blocks.call(this, document, nodes)
		})
		let body = ""

		for (let k = 0; k < 3000; k++) body += p(`Paragraph ${String(k)}`)

		try {
			expect((await convertText(buildDocx({ body }), "docx", "odt")).ok).toBe(true)
		} finally {
			spy.mockRestore()
		}

		seen.clear()

		for (let round = 0; round < 3; round++) {
			gc()
			await new Promise(resolve => setImmediate(resolve))
		}

		// 3000 paragraphs are 47 runs of 64 blocks.
		expect(emitters.size).toBeGreaterThan(0)
		expect(collected).toBeGreaterThanOrEqual(46)
	})
})

describe("docx → odt text kept and counted", () => {
	it("writes ruby as text:ruby, its guide text kept", async () => {
		const written = await content({
			body: '<w:p><w:r><w:ruby><w:rubyPr><w:rubyAlign w:val="center"/><w:hps w:val="10"/><w:hpsRaise w:val="18"/><w:hpsBaseText w:val="20"/><w:lid w:val="ja-JP"/></w:rubyPr><w:rt><w:r><w:t>RUBYTOP</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>RUBYBASE</w:t></w:r></w:rubyBase></w:ruby></w:r></w:p>'
		})

		expect(written).toContain(
			"<text:ruby><text:ruby-base>RUBYBASE</text:ruby-base><text:ruby-text>RUBYTOP</text:ruby-text></text:ruby>"
		)
	})

	it("keeps a ruby base's formatting and tabs, and a note in it after the ruby", async () => {
		const styled = await content({
			body: "<w:p><w:r><w:ruby><w:rubyPr/><w:rt><w:r><w:rPr><w:b/></w:rPr><w:t>TOP</w:t></w:r><w:r><w:t>2</w:t></w:r></w:rt><w:rubyBase><w:r><w:rPr><w:i/></w:rPr><w:t>BASE</w:t></w:r><w:r><w:tab/><w:t>B2</w:t></w:r></w:rubyBase></w:ruby></w:r></w:p>"
		})

		expect(styled).toMatch(
			/<text:ruby><text:ruby-base><text:span text:style-name="[^"]+">BASE<\/text:span><text:tab\/>B2<\/text:ruby-base><text:ruby-text>TOP2<\/text:ruby-text><\/text:ruby>/u
		)
		expect(styled).toMatch(/style:family="text"><style:text-properties fo:font-style="italic"/u)

		const noted = await content({
			body: '<w:p><w:r><w:ruby><w:rubyPr/><w:rt><w:r><w:t>NT</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>NB</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:rubyBase></w:ruby></w:r></w:p>',
			footnotes: '<w:footnote w:id="1"><w:p><w:r><w:t>RubyNote</w:t></w:r></w:p></w:footnote>'
		})

		expect(noted).toMatch(
			/<text:ruby><text:ruby-base>NB<\/text:ruby-base><text:ruby-text>NT<\/text:ruby-text><\/text:ruby><text:note [^>]*>.*RubyNote/u
		)
	})

	it("counts a bidirectional override or embedding it cannot hold", async () => {
		const converted = await convertText(
			buildDocx({
				body: '<w:p><w:bdo w:val="rtl"><w:r><w:t>BDOTEXT</w:t></w:r></w:bdo><w:dir w:val="rtl"><w:r><w:t>DIRTEXT</w:t></w:r></w:dir></w:p>'
			}),
			"docx",
			"odt"
		)

		if (!converted.ok) throw new Error(converted.refusal.message)

		expect(converted.lossy.features).toContainEqual({ kind: "runFormat", count: 2 })
	})
})

describe("doc → docx of a renamed package", () => {
	it("writes a macro-enabled document renamed .doc as a .docx without its macros, and counts them", async () => {
		const source = buildDocx({
			body: p("Macro document"),
			mainContentType: "application/vnd.ms-word.document.macroEnabled.main+xml",
			parts: [
				{
					name: "word/vbaProject.bin",
					contentType: "application/vnd.ms-office.vbaProject",
					data: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])
				},
				{
					name: "word/vbaData.xml",
					contentType: "application/vnd.ms-word.vbaData+xml",
					data: '<?xml version="1.0"?><wne:vbaSuppData xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"/>'
				},
				{
					name: "word/_rels/vbaProject.bin.rels",
					data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2006/relationships/wordVbaData" Target="vbaData.xml"/></Relationships>'
				}
			],
			relationships: [
				{ id: "rIdVba", type: "http://schemas.microsoft.com/office/2006/relationships/vbaProject", target: "vbaProject.bin" }
			]
		})
		const converted = await convertText(source, "doc", "docx")

		if (!converted.ok) throw new Error(converted.refusal.message)

		const archive = await ZipArchive.open(bytesSource(converted.bytes))
		const part = async (name: string): Promise<string> => {
			const entry = archive.get(name)

			return entry === undefined ? "" : decodeUtf8(await archive.read(entry))
		}

		expect(converted.lossy.features).toContainEqual({ kind: "macros", count: 1 })
		expect(archive.entries.map(entry => entry.name).filter(name => /vba/iu.test(name))).toEqual([])
		expect(await part("[Content_Types].xml")).toContain(
			'PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"'
		)
		expect(await part("[Content_Types].xml")).not.toMatch(/vba/iu)
		expect(await part("word/_rels/document.xml.rels")).not.toMatch(/vba/iu)
		expect(await part("word/document.xml")).toContain("Macro document")
	})

	it("leaves out only what the macros alone relate, and refuses a project relating the document", async () => {
		const VBA = "http://schemas.microsoft.com/office/2006/relationships/vbaProject"
		const docm = (rels: string, extra: SyntheticDocx["parts"] = [], relationships: SyntheticDocx["relationships"] = []): Uint8Array =>
			buildDocx({
				body: p("Shared"),
				mainContentType: "application/vnd.ms-word.document.macroEnabled.main+xml",
				parts: [
					{
						name: "word/vbaProject.bin",
						contentType: "application/vnd.ms-office.vbaProject",
						data: new Uint8Array([0xd0, 0xcf])
					},
					{
						name: "word/_rels/vbaProject.bin.rels",
						data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`
					},
					...(extra ?? [])
				],
				relationships: [{ id: "rIdVba", type: VBA, target: "vbaProject.bin" }, ...(relationships ?? [])]
			})
		const shared = await convertText(
			docm(
				'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>',
				[{ name: "word/media/image1.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }],
				[{ id: "rIdImg", type: "image", target: "media/image1.png" }]
			),
			"doc",
			"docx"
		)

		if (!shared.ok) throw new Error(shared.refusal.message)

		const names = (await ZipArchive.open(bytesSource(shared.bytes))).entries.map(entry => entry.name)

		expect(names).toContain("word/media/image1.png")
		expect(names).not.toContain("word/vbaProject.bin")

		for (const target of ["document.xml", "../[Content_Types].xml", "_rels/document.xml.rels"]) {
			const hostile = await convertText(docm(`<Relationship Id="rId1" Type="x" Target="${target}"/>`), "doc", "docx")

			expect(hostile.ok ? "ok" : hostile.refusal.reason).toBe("corrupt")
		}
	})

	it("passes a .docx renamed .doc through as its bytes", async () => {
		const source = buildDocx({ body: p("Plain") })
		const converted = await convertText(source, "doc", "docx")

		if (!converted.ok) throw new Error(converted.refusal.message)

		expect(converted.bytes).toBe(source)
	})
})

describe("odt → docx: a hyperlink inside a tracked change", () => {
	const W =
		'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
	const standalone = (body: string): string => {
		const parts = new Map([["word/document.xml", encodeUtf8(`<w:document ${W}><w:body><w:p>${body}</w:p></w:body></w:document>`)]])

		standaloneParts(parts, new LossyCounts())

		const written = decodeUtf8(parts.get("word/document.xml") ?? new Uint8Array())

		assertWellFormed(parseXml(encodeUtf8(written)))

		return written
	}

	it('writes an .odt\'s internal link holding ">" in a tracked insertion as a well-formed .docx', async () => {
		const source = odtBytes({
			body:
				'<text:tracked-changes><text:changed-region text:id="c1"><text:insertion><office:change-info><dc:creator>A</dc:creator><dc:date>2024-01-01T00:00:00</dc:date></office:change-info></text:insertion></text:changed-region></text:tracked-changes>' +
				'<text:p>x<text:change-start text:change-id="c1"/>a <text:a xlink:type="simple" xlink:href="#Settings &gt; Privacy">link</text:a> b<text:change-end text:change-id="c1"/></text:p>'
		})
		const converted = await convertText(source, "odt", "docx")

		if (!converted.ok) throw new Error(converted.refusal.message)

		const archive = await ZipArchive.open(bytesSource(converted.bytes))
		const entry = archive.get("word/document.xml")
		const body = entry === undefined ? "" : decodeUtf8(await archive.read(entry))

		assertWellFormed(parseXml(encodeUtf8(body)))
		expect(body).toMatch(/<w:hyperlink w:anchor="Settings > Privacy"><w:ins w:id="\d+"[^>]*>(?:(?!<\/w:ins>).)*link/su)
	})

	it('reads an anchor holding ">" in the package\'s own markup, either quote, and leaves a self-closing hyperlink as it is', () => {
		expect(
			standalone(
				'<w:ins w:id="7" w:author="A"><w:r><w:t>a</w:t></w:r><w:hyperlink w:anchor="Settings > Privacy"><w:r><w:t>b</w:t></w:r></w:hyperlink></w:ins>'
			)
		).toContain(
			'<w:ins w:id="1" w:author="A"><w:r><w:t>a</w:t></w:r></w:ins><w:hyperlink w:anchor="Settings > Privacy"><w:ins w:id="2" w:author="A"><w:r><w:t>b</w:t></w:r></w:ins></w:hyperlink>'
		)
		expect(
			standalone(
				'<w:ins w:id="7" w:author="A"><w:r><w:t>a</w:t></w:r><w:hyperlink w:anchor=\'Settings > "Privacy"\'><w:r><w:t>b</w:t></w:r></w:hyperlink></w:ins>'
			)
		).toContain(
			'<w:ins w:id="1" w:author="A"><w:r><w:t>a</w:t></w:r></w:ins><w:hyperlink w:anchor=\'Settings > "Privacy"\'><w:ins w:id="2" w:author="A"><w:r><w:t>b</w:t></w:r></w:ins></w:hyperlink>'
		)
		expect(standalone('<w:ins w:id="7" w:author="A"><w:r><w:t>a</w:t></w:r><w:hyperlink w:anchor="x > y"/></w:ins>')).toContain(
			'<w:ins w:id="1" w:author="A"><w:r><w:t>a</w:t></w:r></w:ins><w:hyperlink w:anchor="x > y"/>'
		)
	})
})

describe("doc → docx of a renamed package, cancelled", () => {
	const macroDocument = (): Uint8Array =>
		buildDocx({
			body: p("Macro document"),
			mainContentType: "application/vnd.ms-word.document.macroEnabled.main+xml",
			parts: [
				{ name: "word/vbaProject.bin", contentType: "application/vnd.ms-office.vbaProject", data: new Uint8Array([0xd0, 0xcf]) }
			],
			relationships: [
				{ id: "rIdVba", type: "http://schemas.microsoft.com/office/2006/relationships/vbaProject", target: "vbaProject.bin" }
			]
		})

	it("reports a cancel while the package is rewritten as aborted", async () => {
		const signal = { aborted: false }
		const converted = await convertText(macroDocument(), "doc", "docx", {
			turns: {
				signal,
				slicing: {
					pause: () => {
						signal.aborted = true

						return Promise.resolve()
					},
					sliceMs: 0,
					now: () => 0
				}
			}
		})

		expect(converted.ok ? "ok" : converted.refusal.reason).toBe("aborted")
	})

	it("converts the same package when not cancelled, and reads a ZIP that is no Word package as a binary document", async () => {
		const converted = await convertText(macroDocument(), "doc", "docx", {
			turns: { signal: { aborted: false }, slicing: { pause: () => Promise.resolve(), sliceMs: 0, now: () => 0 } }
		})

		expect(converted.ok).toBe(true)

		const other = await convertText(buildZip([{ name: "a.txt", data: text("a") }]), "doc", "docx")

		expect(other.ok ? "ok" : other.refusal.reason).toBe("notSource")
	})
})
