import { describe, expect, it } from "vitest"
import { TextSelection } from "prosemirror-state"
import { ZipArchive, bytesSource } from "@filen/office/core/opc"
import { decodeUtf8, encodeUtf8 } from "@filen/office/core/xml"
import { proveOdtWritten, writeOdt } from "../core/odt/write/writer"
import { buildZip } from "./zipBuilder"
import { odtBytes, translated, type OdtParts } from "./odtFixtures"
import { editOdt, odtEditsOf } from "./odtWriteFixtures"
import { PNG } from "./rtfWriteFixtures"
import { splitParagraph } from "../core/docx/paged/index"

// Each expectation states what a correct save does.

type Editing = Awaited<ReturnType<typeof editOdt>>
const STYLES =
	'<style:default-style style:family="paragraph"><style:text-properties fo:font-size="12pt"/></style:default-style><style:style style:name="Standard" style:family="paragraph"/>'
async function content(bytes: Uint8Array, name = "content.xml"): Promise<string> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const entry = archive.get(name)
	if (entry === undefined) throw new Error(name)
	return decodeUtf8(await archive.read(entry))
}
function nth(e: Editing, i: number): { pos: number } {
	let found: { pos: number } | undefined
	let k = 0
	e.session.state.doc.descendants((node, pos) => {
		if (found !== undefined) return false
		if (node.type.name === "paragraph") {
			if (k++ === i) found = { pos }
			return false
		}
		return true
	})
	if (found === undefined) throw new Error(`no paragraph ${i}`)
	return found
}
function select(e: Editing, from: number, to = from): void {
	e.session.dispatch(e.session.state.tr.setSelection(TextSelection.create(e.session.state.doc, from, to)))
}
async function save(parts: OdtParts | Uint8Array, edit: (e: Editing) => Promise<void> | void): Promise<Uint8Array> {
	const e = await editOdt(parts instanceof Uint8Array ? parts : odtBytes({ styles: STYLES, ...parts }))
	await edit(e)
	return (await writeOdt(e.source, await odtEditsOf(e))).bytes
}
const typeAt = (i: number, offset: number, text: string) => (e: Editing) => {
	e.session.dispatch(e.session.state.tr.insertText(text, nth(e, i).pos + 1 + offset))
}

describe("ODT writer fidelity", () => {
	it("typed ]]> is escaped (XML 1.0 §2.4): content.xml stays well-formed", async () => {
		const bytes = await save({ body: "<text:p>Code</text:p>" }, typeAt(0, 4, " a[b[0]]>c"))
		expect(await content(bytes)).not.toContain("]]>")
	})
	it("typing in a paragraph keeps an overlined span's overline", async () => {
		const bytes = await save(
			{
				automatic:
					'<style:style style:name="T1" style:family="text"><style:text-properties style:text-overline-style="solid" style:text-overline-width="auto" style:text-overline-color="font-color"/></style:style>',
				body: '<text:p>Hello <text:span text:style-name="T1">overlined</text:span> end</text:p>'
			},
			typeAt(0, 1, "Z")
		)
		expect(await content(bytes)).toMatch(/<text:span text:style-name="T1">overlined<\/text:span>/u)
	})
	it("typing in a paragraph keeps East Asian bold, italic and size of a span", async () => {
		const bytes = await save(
			{
				automatic:
					'<style:style style:name="T1" style:family="text"><style:text-properties style:font-weight-asian="bold" style:font-size-asian="20pt" style:font-style-asian="italic"/></style:style>',
				body: '<text:p>Start <text:span text:style-name="T1">漢字かな</text:span> end</text:p>'
			},
			typeAt(0, 1, "Z")
		)
		expect(await content(bytes)).toContain('<text:span text:style-name="T1">漢字かな</text:span>')
	})
	it("bolding part of a span keeps its untranslated properties (overline, custom escapement)", async () => {
		const bytes = await save(
			{
				automatic:
					'<style:style style:name="T1" style:family="text"><style:text-properties style:text-overline-style="solid" style:text-overline-color="font-color" style:text-position="33% 80%" style:font-relief="embossed"/></style:style>',
				body: '<text:p>Hello <text:span text:style-name="T1">overlined words</text:span> end</text:p>'
			},
			async e => {
				const at = nth(e, 0).pos + 1
				select(e, at + 6, at + 15)
				await e.editor.execute({ type: "format.bold" })
			}
		)
		const xml = await content(bytes)
		const bold =
			/<style:style style:name="(T\d+)" style:family="text"><style:text-properties([^>]*fo:font-weight="bold"[^>]*)\/>/u.exec(xml)
		expect(bold?.[2]).toContain("style:text-overline-style")
		expect(bold?.[2]).toContain('style:text-position="33% 80%"')
	})
	it("an alignment change keeps the paragraph's drop cap", async () => {
		const bytes = await save(
			{
				automatic:
					'<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="start"><style:drop-cap style:lines="3" style:length="1"/></style:paragraph-properties></style:style>',
				body: '<text:p text:style-name="P1">Dropped capital paragraph</text:p>'
			},
			async e => {
				select(e, nth(e, 0).pos + 2)
				await e.editor.execute({ type: "align.center" })
			}
		)
		const xml = await content(bytes)
		const used = /<text:p text:style-name="([^"]+)">Dropped/u.exec(xml)?.[1]
		expect(new RegExp(`<style:style style:name="${used}"[^>]*>(?:(?!</style:style>).)*<style:drop-cap`, "u").test(xml)).toBe(true)
	})
	it("bulleting a middle item keeps the numbering after it continuing (ODF 1.3 Part 3 §19.786: only the preceding list continues)", async () => {
		const LS =
			'<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.635cm" fo:margin-left="1.27cm"/></style:list-level-properties></text:list-level-style-number></text:list-style>'
		const bytes = await save(
			{
				automatic: LS,
				body: `<text:list text:style-name="L1">${["one", "two", "three", "four"].map(x => `<text:list-item><text:p>${x}</text:p></text:list-item>`).join("")}</text:list>`
			},
			async e => {
				select(e, nth(e, 1).pos + 2)
				await e.editor.execute({ type: "list.bullet" })
			}
		)
		const xml = await content(bytes)
		// The list holding "three" follows the bullet list: text:continue-numbering continues that one (another style:
		// no continuation, LibreOffice numbers three 1.); only text:continue-list (§19.785) names the first.
		expect(xml).toMatch(/<text:list [^>]*text:continue-list="[^"]+"[^>]*><text:list-item><text:p>three/u)
	})
	it("refuses a list continuing past another one in a document of ODF 1.0, which has no text:continue-list", async () => {
		const LS =
			'<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.635cm" fo:margin-left="1.27cm"/></style:list-level-properties></text:list-level-style-number></text:list-style>'
		const source = await rezip(
			odtBytes({
				styles: STYLES,
				automatic: LS,
				body: `<text:list text:style-name="L1">${["one", "two", "three"].map(x => `<text:list-item><text:p>${x}</text:p></text:list-item>`).join("")}</text:list>`
			}),
			"content.xml",
			xml => xml.replace('office:version="1.3"', 'office:version="1.0"')
		)

		await expect(
			save(source, async e => {
				select(e, nth(e, 1).pos + 2)
				await e.editor.execute({ type: "list.bullet" })
			})
		).rejects.toMatchObject({ reason: "list" })
	})
	it("inserting a picture the file already holds (a second session) saves", async () => {
		const insert = async (e: Editing): Promise<void> => {
			select(e, nth(e, 0).pos + 3)
			await e.editor.execute({ type: "image.insert", media: e.session.context.media.add(PNG), altText: "dots" } as never)
		}
		const first = await save({ body: "<text:p>One para</text:p>" }, insert)
		await expect(save(first, insert)).resolves.toBeInstanceOf(Uint8Array)
	})
	it("repeated format saves do not pile up unused automatic styles", async () => {
		let bytes = await save({ body: "<text:p>one two three</text:p>" }, async e => {
			const at = nth(e, 0).pos + 1
			select(e, at, at + 3)
			await e.editor.execute({ type: "format.bold" })
		})
		for (let round = 0; round < 6; round++) {
			bytes = await save(bytes, async e => {
				const at = nth(e, 0).pos + 1
				select(e, at, at + 3)
				await e.editor.execute({ type: "format.bold" })
			})
		}
		const xml = await content(bytes)
		const defined = [...xml.matchAll(/<style:style style:name="([^"]+)"/gu)].map(m => m[1])
		const used = defined.filter(name => xml.includes(`text:style-name="${name}"`))
		expect(defined.length - used.length).toBeLessThanOrEqual(1)
	})
	it("Enter in a list item that restarts its numbering saves", async () => {
		const LS =
			'<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.635cm" fo:margin-left="1.27cm"/></style:list-level-properties></text:list-level-style-number></text:list-style>'
		const bytes = await save(
			{
				automatic: LS,
				body: '<text:list text:style-name="L1"><text:list-item><text:p>one</text:p></text:list-item><text:list-item text:start-value="7"><text:p>seven</text:p></text:list-item><text:list-item><text:p>eight</text:p></text:list-item></text:list>'
			},
			e => {
				select(e, nth(e, 1).pos + 4)

				const split = splitParagraph(e.session.state, e.session.formats)

				if (split !== null) e.session.dispatch(split)
			}
		)
		expect(await content(bytes)).toMatch(/<text:list-item text:start-value="7"><text:p>sev<\/text:p>/u)
	})
	it("deleting the paragraph that holds a bookmark's start saves", async () => {
		const bytes = await save(
			{
				body: '<text:p>Alpha <text:bookmark-start text:name="bm"/>start</text:p><text:p>Middle para</text:p><text:p>end<text:bookmark-end text:name="bm"/> omega</text:p><text:p>see <text:bookmark-ref text:reference-format="page" text:ref-name="bm">1</text:bookmark-ref></text:p>'
			},
			e => {
				const at = nth(e, 0).pos

				e.session.dispatch(e.session.state.tr.delete(at, nth(e, 1).pos))
			}
		)
		expect(await content(bytes)).not.toContain("Alpha")
	})
	it("inserting a row below a row a cell spans into saves", async () => {
		const bytes = await save(
			{
				body:
					'<text:p>Before</text:p><table:table table:name="T"><table:table-column table:number-columns-repeated="2"/>' +
					'<table:table-row><table:table-cell table:number-rows-spanned="2" office:value-type="string"><text:p>span</text:p></table:table-cell><table:table-cell><text:p>b1</text:p></table:table-cell></table:table-row>' +
					"<table:table-row><table:covered-table-cell/><table:table-cell><text:p>b2</text:p></table:table-cell></table:table-row>" +
					"<table:table-row><table:table-cell><text:p>a3</text:p></table:table-cell><table:table-cell><text:p>b3</text:p></table:table-cell></table:table-row></table:table>"
			},
			async e => {
				select(e, nth(e, 1).pos + 1)
				await e.editor.execute({ type: "table.row.insertBelow" })
			}
		)
		expect((await content(bytes)).match(/<table:table-row/gu)?.length).toBe(4)
	})
	it("adding a comment saves it as an annotation", async () => {
		const bytes = await save({ body: "<text:p>Plain para words</text:p>" }, async e => {
			const at = nth(e, 0).pos + 1

			select(e, at, at + 5)
			await e.editor.execute({ type: "comment.add", text: 'Note <&> "q"' } as never)
		})
		expect(await content(bytes)).toMatch(
			/<office:annotation [^>]*>.*Note &lt;&amp;&gt; "q".*<\/office:annotation>Plain<office:annotation-end/u
		)
	})
	it("the translation reports the text properties it does not hold (an overline, East Asian bold apart from Latin)", async () => {
		const reasons = async (properties: string): Promise<number | undefined> =>
			(
				await translated({
					automatic: `<style:style style:name="T1" style:family="text"><style:text-properties ${properties}/></style:style>`,
					body: '<text:p>Start <text:span text:style-name="T1">span</text:span></text:p>'
				})
			).lossy.get("untranslatedText")

		expect(await reasons('style:text-overline-style="solid"')).toBe(1)
		expect(await reasons('style:font-weight-asian="bold"')).toBe(1)
		expect(await reasons('fo:font-weight="bold" style:font-weight-asian="bold" fo:hyphenate="false"')).toBeUndefined()
	})
	it("bolding writes the East Asian weight too (ECMA-376 Part 1 §17.3.2.1: w:b is not complex-script only)", async () => {
		const bytes = await save({ body: "<text:p>Start 漢字かな end</text:p>" }, async e => {
			const at = nth(e, 0).pos + 1

			select(e, at + 6, at + 10)
			await e.editor.execute({ type: "format.bold" })
		})
		expect(await content(bytes)).toMatch(/<style:text-properties[^>]*fo:font-weight="bold"[^>]*style:font-weight-asian="bold"/u)
	})
	it("splitting an overlined span keeps the overline on both halves", async () => {
		const bytes = await save(
			{
				automatic:
					'<style:style style:name="T1" style:family="text"><style:text-properties style:text-overline-style="solid" style:text-overline-color="font-color"/></style:style>',
				body: '<text:p>Hello <text:span text:style-name="T1">overlined words</text:span> end</text:p>'
			},
			e => {
				select(e, nth(e, 0).pos + 1 + 15)

				const split = splitParagraph(e.session.state, e.session.formats)

				if (split !== null) e.session.dispatch(split)
			}
		)
		const xml = await content(bytes)

		expect(xml).toContain('<text:span text:style-name="T1">overlined</text:span>')
		expect(xml).toContain('<text:span text:style-name="T1"><text:s/>words</text:span>')
	})
	it("joining a paragraph to the one before keeps its overlined span", async () => {
		const bytes = await save(
			{
				automatic:
					'<style:style style:name="T1" style:family="text"><style:text-properties style:text-overline-style="solid" style:text-overline-color="font-color"/></style:style>',
				body: '<text:p>First</text:p><text:p>Second <text:span text:style-name="T1">overlined</text:span></text:p>'
			},
			e => {
				const end = nth(e, 0).pos + 1 + 5

				e.session.dispatch(e.session.state.tr.delete(end, nth(e, 1).pos + 1))
			}
		)

		expect(await content(bytes)).toContain('<text:p>FirstSecond <text:span text:style-name="T1">overlined</text:span></text:p>')
	})
	describe("deleting text the same as a span's beside it keeps each span on its own characters", () => {
		const OVERLINE =
			'<style:style style:name="T1" style:family="text"><style:text-properties style:text-overline-style="solid" style:text-overline-color="font-color"/></style:style>'
		const deleting = async (automatic: string, body: string, from: number, to: number): Promise<string> =>
			content(
				await save({ automatic, body }, e => {
					const at = nth(e, 0).pos + 1

					e.session.dispatch(e.session.state.tr.delete(at + from, at + to))
				})
			)

		it("the plain copy before the span", async () => {
			expect(await deleting(OVERLINE, '<text:p>xyz<text:span text:style-name="T1">xyz</text:span></text:p>', 0, 3)).toContain(
				'<text:p><text:span text:style-name="T1">xyz</text:span></text:p>'
			)
		})
		it("the plain copy after the span", async () => {
			expect(await deleting(OVERLINE, '<text:p><text:span text:style-name="T1">xyz</text:span>xyz</text:p>', 3, 6)).toContain(
				'<text:p><text:span text:style-name="T1">xyz</text:span></text:p>'
			)
		})
		it("the span before a plain copy", async () => {
			expect(await deleting(OVERLINE, '<text:p><text:span text:style-name="T1">xyz</text:span>xyz</text:p>', 0, 3)).toContain(
				"<text:p>xyz</text:p>"
			)
		})
		it("the plain copy before a span in the middle", async () => {
			expect(await deleting(OVERLINE, '<text:p>xyz<text:span text:style-name="T1">xyz</text:span>xyz</text:p>', 0, 3)).toContain(
				'<text:p><text:span text:style-name="T1">xyz</text:span>xyz</text:p>'
			)
		})
		it("East Asian bold and size", async () => {
			expect(
				await deleting(
					'<style:style style:name="T2" style:family="text"><style:text-properties style:font-weight-asian="bold" style:font-size-asian="20pt"/></style:style>',
					'<text:p>漢字<text:span text:style-name="T2">漢字</text:span>かな</text:p>',
					0,
					2
				)
			).toContain('<text:p><text:span text:style-name="T2">漢字</text:span>かな</text:p>')
		})
	})
	it("a split keeps the paragraph's xml:id on its first half and gives the second its own", async () => {
		const bytes = await save({ body: '<text:p xml:id="para7">First half second half</text:p>' }, e => {
			select(e, nth(e, 0).pos + 1 + 10)

			const split = splitParagraph(e.session.state, e.session.formats)

			if (split !== null) e.session.dispatch(split)
		})
		const xml = await content(bytes)
		const ids = [...xml.matchAll(/<text:p [^>]*xml:id="([^"]+)"/gu)].map(match => match[1])

		expect(xml).toMatch(/<text:p [^>]*xml:id="para7"[^>]*>First half<\/text:p>/u)
		expect(ids).toHaveLength(2)
		expect(new Set(ids).size).toBe(2)
	})
	it("an edited save drops the preview image of the first page it no longer shows (ODF 1.3 Part 2 §3.8)", async () => {
		const source = odtBytes({
			styles: STYLES,
			body: "<text:p>One para</text:p>",
			extra: [{ name: "Thumbnails/thumbnail.png", data: PNG }]
		})
		const bytes = await save(source, typeAt(0, 3, "X"))
		const archive = await ZipArchive.open(bytesSource(bytes))

		expect(archive.get("Thumbnails/thumbnail.png")).toBeUndefined()
		expect(await content(bytes, "META-INF/manifest.xml")).not.toContain("Thumbnails")
	})
	it("a second session's tracked change takes an id the first did not", async () => {
		// Typed with tracking on in the last paragraph the editor lets one type in.
		const track = (e: Editing): void => {
			let at = -1

			e.session.state.doc.descendants((node, pos) => {
				if (node.isTextblock && node.textContent.startsWith("Para")) at = pos

				return true
			})
			e.session.context.identity.author = "Filen"
			e.session.context.review.tracking = true
			e.session.dispatch(e.session.state.tr.insertText("Z", at + 3))
			e.session.context.review.tracking = false
		}
		const first = await save({ body: "<text:p>Para one</text:p><text:p>Para two</text:p>" }, track)
		const xml = await content(await save(first, track))
		const ids = [...xml.matchAll(/<text:changed-region [^>]*xml:id="([^"]+)"/gu)].map(match => match[1])

		expect(ids.length).toBeGreaterThanOrEqual(2)
		expect(new Set(ids).size).toBe(ids.length)
	})
	it("the proof refuses a written file that is not well-formed (XML 1.0 §2.4) however leniently it reads", async () => {
		const e = await editOdt(odtBytes({ styles: STYLES, body: "<text:p>Code</text:p>" }))

		typeAt(0, 4, " more")(e)

		const edits = await odtEditsOf(e)
		const written = (await writeOdt(e.source, edits)).bytes
		const broken = await rezip(written, "content.xml", xml => xml.replace("more", "m]]>ore"))
		const proved = await proveOdtWritten(e.source, edits, broken)

		expect(proved.span).toBe(false)
		expect(proved.whole).not.toBe("done")
	})
	it("the whole proof refuses a written file whose manifest leaves out a picture it holds (Part 2 §3.2)", async () => {
		const e = await editOdt(odtBytes({ styles: STYLES, body: "<text:p>One para</text:p>" }))

		select(e, nth(e, 0).pos + 3)
		await e.editor.execute({ type: "image.insert", media: e.session.context.media.add(PNG), altText: "dots" } as never)

		const edits = await odtEditsOf(e)
		const written = (await writeOdt(e.source, edits)).bytes
		const unlisted = await rezip(written, "META-INF/manifest.xml", xml =>
			xml.replace(/<manifest:file-entry manifest:full-path="Pictures[^>]*\/>/u, "")
		)

		expect((await proveOdtWritten(e.source, edits, written)).whole).toBe("done")
		expect((await proveOdtWritten(e.source, edits, unlisted)).whole).toContain("manifest")
	})
	it("the span proof checks styles.xml was copied rather than assuming it", async () => {
		const e = await editOdt(odtBytes({ styles: STYLES, body: "<text:p>One para</text:p><text:p>Two para</text:p>" }))

		typeAt(0, 1, "Z")(e)

		const edits = await odtEditsOf(e)
		const written = (await writeOdt(e.source, edits)).bytes
		const mutated = await rezip(written, "styles.xml", xml => xml.replace('fo:margin-left="2cm"', 'fo:margin-left="7cm"'))

		expect((await proveOdtWritten(e.source, edits, written)).span).toBe(true)
		expect((await proveOdtWritten(e.source, edits, mutated)).span).toBe(false)
	})
})

async function rezip(bytes: Uint8Array, name: string, change: (text: string) => string): Promise<Uint8Array> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const entries = []

	for (const entry of archive.entries) {
		const data = await archive.read(entry)

		entries.push({
			name: entry.name,
			data: entry.name === name ? encodeUtf8(change(decodeUtf8(data))) : data,
			method: entry.method === 0 ? (0 as const) : (8 as const)
		})
	}

	return buildZip(entries)
}
