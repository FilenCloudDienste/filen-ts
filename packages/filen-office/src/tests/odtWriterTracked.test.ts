import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "../core/opc/index"
import { decodeUtf8 } from "../core/xml/index"
import { odtBytes } from "./odtFixtures"
import { editOdt, saveOdt, type OdtEditing } from "./odtWriteFixtures"
import { paragraphs } from "./rtfWriteFixtures"

// Paragraphs holding tracked changes (ODF 1.3 Part 3 §5.5: text:change-start/-end around an insertion, text:change
// where a deletion was, each recorded in text:tracked-changes) stay editable: a rewrite records their changes anew
// and leaves out the records it replaced.

async function content(bytes: Uint8Array): Promise<string> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const found = archive.get("content.xml")

	if (found === undefined) throw new Error("no content.xml")

	return decodeUtf8(await archive.read(found))
}

function first(editing: OdtEditing): number {
	const paragraph = paragraphs(editing.session.state.doc)[0]

	if (paragraph === undefined) throw new Error("no paragraph")

	return paragraph.pos
}

// Ann inserts "new " after "One " and deletes "three", tracked.
async function tracked(bytes: Uint8Array): Promise<Uint8Array> {
	const editing = await editOdt(bytes)
	const at = first(editing)

	editing.opened.context.identity.author = "Ann"
	editing.opened.context.review.tracking = true
	editing.session.dispatch(editing.session.state.tr.insertText("new ", at + 5))
	editing.session.dispatch(editing.session.state.tr.delete(at + 13, at + 18))

	return (await saveOdt(editing)).bytes
}

const records = (xml: string): string[] => [...xml.matchAll(/<text:changed-region [^>]*text:id="([^"]+)"/gu)].map(match => match[1] ?? "")
const marks = (xml: string): string[] => [...xml.matchAll(/text:change-id="([^"]+)"/gu)].map(match => match[1] ?? "")

describe("an ODT paragraph with tracked changes", () => {
	it("reopens editable after a save that tracked an insertion and a deletion", async () => {
		const saved = await tracked(odtBytes({ body: "<text:p>One two three</text:p><text:p>Last</text:p>" }))
		const reopened = await editOdt(saved)

		expect(reopened.locked).toBe(0)
		expect(reopened.session.state.doc.textContent).toContain("One new two three")
	})

	it("saves again after an edit beside its changes, recording each change once", async () => {
		const saved = await tracked(odtBytes({ body: "<text:p>One two three</text:p><text:p>Last</text:p>" }))
		const editing = await editOdt(saved)

		editing.session.dispatch(editing.session.state.tr.insertText("Z", first(editing) + 1))

		const again = (await saveOdt(editing)).bytes
		const xml = await content(again)

		expect(xml).toMatch(
			/<text:p>ZOne <text:change-start text:change-id="([^"]+)"\/>new <text:change-end text:change-id="\1"\/>two<text:s\/><text:change text:change-id="[^"]+"\/><\/text:p>/u
		)
		expect(records(xml)).toHaveLength(2)
		expect(new Set(marks(xml))).toEqual(new Set(records(xml)))
		expect(xml).toMatch(
			/<text:deletion><office:change-info><dc:creator>Ann<\/dc:creator><dc:date>[^<]+<\/dc:date><\/office:change-info><text:p>three<\/text:p><\/text:deletion>/u
		)
		expect((await editOdt(again)).locked).toBe(0)
	})

	it.each([
		[
			"an insertion over two paragraphs",
			'<text:tracked-changes><text:changed-region xml:id="c1" text:id="c1"><text:insertion><office:change-info><dc:creator>Ann</dc:creator><dc:date>2020-01-01T00:00:00</dc:date></office:change-info></text:insertion></text:changed-region></text:tracked-changes><text:p>One <text:change-start text:change-id="c1"/>two</text:p><text:p>three<text:change-end text:change-id="c1"/> four</text:p>'
		],
		[
			"a change whose record holds a comment",
			'<text:tracked-changes><text:changed-region xml:id="c1" text:id="c1"><text:insertion><office:change-info><dc:creator>Ann</dc:creator><dc:date>2020-01-01T00:00:00</dc:date><text:p>Why</text:p></office:change-info></text:insertion></text:changed-region></text:tracked-changes><text:p>One <text:change-start text:change-id="c1"/>two<text:change-end text:change-id="c1"/></text:p><text:p>Last</text:p>'
		],
		["a mark with no record", '<text:p>One <text:change text:change-id="c9"/>two</text:p><text:p>Last</text:p>'],
		[
			"an insertion of nothing",
			'<text:tracked-changes><text:changed-region xml:id="c1" text:id="c1"><text:insertion><office:change-info><dc:creator>Ann</dc:creator><dc:date>2020-01-01T00:00:00</dc:date></office:change-info></text:insertion></text:changed-region></text:tracked-changes><text:p>One <text:change-start text:change-id="c1"/><text:change-end text:change-id="c1"/>two</text:p><text:p>Last</text:p>'
		],
		[
			"a deletion of nothing",
			'<text:tracked-changes><text:changed-region xml:id="c1" text:id="c1"><text:deletion><office:change-info><dc:creator>Ann</dc:creator><dc:date>2020-01-01T00:00:00</dc:date></office:change-info><text:p><text:bookmark text:name="b"/></text:p></text:deletion></text:changed-region></text:tracked-changes><text:p>One <text:change text:change-id="c1"/>two</text:p><text:p>Last</text:p>'
		]
	])("stays as the source has it with %s", async (_, body) => {
		const editing = await editOdt(odtBytes({ body }))

		expect(editing.locked).toBeGreaterThan(0)
	})
})
