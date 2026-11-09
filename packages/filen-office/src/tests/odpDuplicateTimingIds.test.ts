import { describe, expect, it } from "vitest"
import { renameIds } from "../core/odp/write/integrity"
import { decodeUtf8, encodeUtf8, parseXml } from "../core/xml/index"
import { odpBytes } from "./odpFixtures"
import { ODP_DECK, changes, entriesOf, odpApplier, openOdpDeck, saveDeck, shapeNamed, slideAt, text } from "./odpWriteFixtures"

// A duplicated page's SMIL begin/end values follow its renamed IDs: the transition par ("<page id>.begin") and the
// click triggers ("<shape id>.click") of the copy name the copy's page and shapes, not the original's.

const TIMED_PAGE =
	'<draw:page draw:name="Timed" draw:master-page-name="M" xml:id="pid1" draw:id="pid1">' +
	'<draw:custom-shape draw:name="Trigger" draw:style-name="gr1" svg:x="3cm" svg:y="6cm" svg:width="4cm" svg:height="2cm" xml:id="id2" draw:id="id2"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="ellipse"/></draw:custom-shape>' +
	'<anim:par presentation:node-type="timing-root">' +
	'<anim:par smil:begin="pid1.begin"><anim:transitionFilter smil:dur="1.6s" smil:type="fade" smil:subtype="crossfade"/></anim:par>' +
	'<anim:seq presentation:node-type="interactive-sequence"><anim:par smil:begin="id2.click"><anim:par smil:begin="0s">' +
	'<anim:par smil:begin="0s" smil:fill="hold" presentation:node-type="on-click" presentation:preset-class="exit" presentation:preset-id="ooo-exit-dissolve">' +
	'<anim:set smil:begin="0.499s" smil:dur="0.001s" smil:fill="hold" smil:targetElement="id2" smil:attributeName="visibility" smil:to="hidden"/>' +
	"</anim:par></anim:par></anim:par></anim:seq></anim:par>" +
	"</draw:page>"

function timedDeck(): Uint8Array {
	const settings = ODP_DECK.body.indexOf("<presentation:settings")

	return odpBytes({ ...ODP_DECK, body: ODP_DECK.body.slice(0, settings) + TIMED_PAGE + ODP_DECK.body.slice(settings) })
}

function pageOf(xml: string, from: number): string {
	return /<draw:page [^>]*>.*?<\/draw:page>/su.exec(xml.slice(from))?.[0] ?? ""
}

function clickShapes(value: unknown, out: number[] = []): number[] {
	if (Array.isArray(value)) for (const each of value) clickShapes(each, out)
	else if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>
		const target = record["tgtEl"] as { kind?: string; shape?: number } | undefined

		if (record["evt"] === "onClick" && target?.kind === "shape" && target.shape !== undefined) out.push(target.shape)

		for (const each of Object.values(record)) clickShapes(each, out)
	}

	return out
}

describe("ODP duplicate: SMIL timing follows renamed IDs", () => {
	it("renames the transition par's page id and the click trigger's shape id in the copy only", async () => {
		const opened = await openOdpDeck(timedDeck())
		const apply = odpApplier(opened)
		const timed = slideAt(opened, 3)

		expect(apply({ family: "slide", kind: "duplicate", slide: timed.ref })).toBeUndefined()

		const saved = await saveDeck(opened, changes("slideList"))

		expect(saved.outcome.kind === "refused" ? saved.outcome : "written").toBe("written")

		const content = text((await entriesOf(saved.bytes)).get("content.xml"))
		const original = pageOf(content, content.indexOf('draw:name="Timed"') - 11)
		const copy = pageOf(content, content.indexOf('draw:name="Timed (2)"') - 11)

		expect(original).toBe(TIMED_PAGE)
		expect(copy).toContain('xml:id="pid1_2" draw:id="pid1_2"')
		expect(copy).toContain('<anim:par smil:begin="pid1_2.begin">')
		expect(copy).toContain('<anim:par smil:begin="id2_2.click">')
		expect(copy).toContain('smil:targetElement="id2_2"')
		expect(copy).not.toMatch(/"(?:pid1|id2)\./u)

		const reopened = await openOdpDeck(saved.bytes)
		const back = slideAt(reopened, 4)

		expect(back.transition?.durationMs).toBe(1600)
		expect(clickShapes(back.timing)).toEqual([shapeNamed(back, "Trigger").id])
		expect(clickShapes(slideAt(reopened, 3).timing)).toEqual([shapeNamed(slideAt(reopened, 3), "Trigger").id])
	})

	it("matches the longest renamed ID before '.', keeps offsets, spacing and values naming no renamed ID", () => {
		const markup =
			'<root><page xml:id="a.b" draw:id="a"><set smil:begin="a.b.click+0.5s; a.end ;next;0s;other.click;indefinite" smil:end="a.b.end-1s" anim:sub-item="a"/></page></root>'
		const document = parseXml(encodeUtf8(markup))
		const page = document.firstChildElement(document.documentElement())
		const editor = renameIds(
			document,
			page,
			new Set(["a.b", "a", "a_2"]),
			(_node, name) => name,
			node => document.name(node)
		)

		if (editor === undefined) throw new Error("nothing renamed")

		const out = decodeUtf8(editor.serialize(), 0, editor.serialize().length)

		expect(out).toContain('xml:id="a.b_2" draw:id="a_3"')
		expect(out).toContain('smil:begin="a.b_2.click+0.5s; a_3.end ;next;0s;other.click;indefinite"')
		expect(out).toContain('smil:end="a.b_2.end-1s"')
		expect(out).toContain('anim:sub-item="a"')
	})
})
