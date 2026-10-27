import { describe, expect, it } from "vitest"
import { matcherOf } from "../core/presentation/edit/find"
import { parseDataModel } from "../core/smartart/data"
import {
	DATA_MODEL_EXT_URI,
	definitionIds,
	detachedDrawingRelId,
	diagramFindTexts,
	diagramOutline,
	editDiagramData,
	newDiagramData,
	withDrawingReference,
	type DiagramEdit,
	type DiagramOutlineNode
} from "../core/smartart/edit"
import { decodeUtf8, encodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"
import { data } from "./smartartFixtures"

// Editing a diagram's data model: node text, structure, find and replace, definitions; every edit keeps the bytes it
// does not touch and leaves a tree parseDataModel reads.

function doc(markup: string): XmlDocument {
	return parseXml(encodeUtf8(markup))
}

function edited(document: XmlDocument, edit: DiagramEdit): XmlDocument {
	const result = editDiagramData(document, edit)

	if (result.kind !== "edited") throw new Error(`not edited: ${JSON.stringify(result)}`)

	return parseXml(result.bytes)
}

function outline(document: XmlDocument): string[] {
	const nodes = diagramOutline(document) as readonly DiagramOutlineNode[]

	return nodes.map(node => `${"-".repeat(node.level)}${node.text}`)
}

const FLAT = doc(
	data([
		{ id: "a", text: "Alpha" },
		{ id: "b", text: "Beta" },
		{ id: "c", text: "Gamma" }
	])
)

const TREE = doc(
	data([
		{ id: "a", text: "A" },
		{ id: "a1", text: "A1", parent: "a" },
		{ id: "a2", text: "A2", parent: "a" },
		{ id: "a3", text: "A3", parent: "a" },
		{ id: "b", text: "B" }
	])
)

describe("SmartArt data edits", () => {
	it("lists the outline depth first in srcOrd order", () => {
		expect(outline(TREE)).toEqual(["-A", "--A1", "--A2", "--A3", "-B"])
	})

	it("sets a node's text, a line per paragraph, keeping its run and paragraph properties", () => {
		const styled = doc(
			data([{ id: "a", text: "x" }]).replace(
				"<a:p><a:r><a:t>x</a:t></a:r></a:p>",
				'<a:p><a:pPr algn="l"/><a:r><a:rPr b="1" lang="de-DE"/><a:t>x</a:t></a:r></a:p>'
			)
		)
		const after = edited(styled, { kind: "setNodeText", node: "a", text: "one\ntwo" })
		const text = decodeUtf8(after.bytes)

		expect(parseDataModel(after).points.get("a")?.paragraphs).toEqual(["one", "two"])
		expect(text.match(/<a:rPr b="1" lang="de-DE"\/>/gu)).toHaveLength(2)
		expect(text.match(/<a:pPr algn="l"\/>/gu)).toHaveLength(2)
	})

	it("adds nodes after, before, below and above, with transitions and unique ids", () => {
		let current = edited(TREE, { kind: "addNode", relativeTo: "a2", position: "after", text: "N1", id: "n1" })

		expect(outline(current)).toEqual(["-A", "--A1", "--A2", "--N1", "--A3", "-B"])

		current = edited(current, { kind: "addNode", relativeTo: "a", position: "before", text: "N2" })
		expect(outline(current)).toEqual(["-N2", "-A", "--A1", "--A2", "--N1", "--A3", "-B"])

		current = edited(current, { kind: "addNode", relativeTo: "b", position: "below", text: "N3" })
		expect(outline(current)).toEqual(["-N2", "-A", "--A1", "--A2", "--N1", "--A3", "-B", "--N3"])

		current = edited(current, { kind: "addNode", relativeTo: "a", position: "above", text: "N4" })
		expect(outline(current)).toEqual(["-N2", "-N4", "--A", "---A1", "---A2", "---N1", "---A3", "-B", "--N3"])

		const model = parseDataModel(current)
		const ids = [...model.points.keys()]

		expect(new Set(ids.map(id => id.toUpperCase())).size).toBe(ids.length)
		expect(model.points.get("n1")?.paragraphs).toEqual(["N1"])
		// Each new node hangs with its parent and sibling transitions.
		expect(model.points.get("n1")?.parent?.children.map(child => child.type)).toContain("parTrans")
	})

	it("adds under the doc point into an empty diagram", () => {
		const empty = doc(data([]))
		const after = editDiagramData(empty, { kind: "addNode", relativeTo: "doc", position: "below", text: "First" })

		expect(after.kind).toBe("edited")
		expect(outline(parseXml((after as { bytes: Uint8Array }).bytes))).toEqual(["-First"])
		expect(editDiagramData(empty, { kind: "addNode", relativeTo: "doc", position: "after" }).kind).toBe("refused")
	})

	it("removes a node, its children taking its place, with its transitions and presentation points", () => {
		const withPres = doc(
			data(
				[
					{ id: "a", text: "A" },
					{ id: "a1", text: "A1", parent: "a" },
					{ id: "b", text: "B" }
				],
				[
					{ id: "pa", prSet: 'presName="box" presAssocID="a" presStyleIdx="0" presStyleCnt="2"' },
					{ id: "pb", prSet: 'presName="box" presAssocID="b" presStyleIdx="1" presStyleCnt="2"' }
				]
			).replace("</dgm:cxnLst>", '<dgm:cxn modelId="x" type="presOf" srcId="a" destId="pa"/></dgm:cxnLst>')
		)
		const after = edited(withPres, { kind: "removeNode", node: "a" })
		const text = decodeUtf8(after.bytes)
		const model = parseDataModel(after)

		expect(outline(after)).toEqual(["-A1", "-B"])
		expect(model.points.has("ap")).toBe(false)
		expect(model.points.has("as")).toBe(false)
		expect(model.points.has("pa")).toBe(false)
		expect(text).not.toContain('destId="pa"')
		// The style counts left are the old layout's: dropped.
		expect(text).not.toContain("presStyleCnt")
		expect(model.points.has("pb")).toBe(true)
	})

	it("promotes a node, its following siblings becoming its children, and demotes under the previous sibling", () => {
		const promoted = edited(TREE, { kind: "promote", node: "a2" })

		expect(outline(promoted)).toEqual(["-A", "--A1", "-A2", "--A3", "-B"])

		const demoted = edited(promoted, { kind: "demote", node: "a2" })

		expect(outline(demoted)).toEqual(["-A", "--A1", "--A2", "---A3", "-B"])
		expect(editDiagramData(TREE, { kind: "promote", node: "a" }).kind).toBe("refused")
		expect(editDiagramData(TREE, { kind: "demote", node: "a1" }).kind).toBe("refused")
	})

	it("moves a node with its subtree among its siblings, refusing past either end", () => {
		const down = edited(TREE, { kind: "moveNode", node: "a", direction: "down" })

		expect(outline(down)).toEqual(["-B", "-A", "--A1", "--A2", "--A3"])
		expect(outline(edited(TREE, { kind: "moveNode", node: "a3", direction: "up" }))).toEqual(["-A", "--A1", "--A3", "--A2", "-B"])
		expect(editDiagramData(TREE, { kind: "moveNode", node: "a", direction: "up" }).kind).toBe("refused")
		expect(editDiagramData(TREE, { kind: "moveNode", node: "zz", direction: "up" })).toMatchObject({ reason: "notFound" })
	})

	it("refuses an unknown node, typed", () => {
		expect(editDiagramData(TREE, { kind: "setNodeText", node: "nope", text: "x" })).toMatchObject({
			kind: "refused",
			reason: "notFound"
		})
		expect(editDiagramData(TREE, { kind: "removeNode", node: "doc" })).toMatchObject({ kind: "refused" })
	})

	it("keeps every byte an edit does not touch", () => {
		const extra = data([{ id: "a", text: "A" }]).replace(
			"</dgm:ptLst>",
			'<dgm:pt modelId="u" type="pres"><dgm:prSet custT="1"/><x:y xmlns:x="urn:x"/></dgm:pt></dgm:ptLst>'
		)
		const after = decodeUtf8(edited(doc(extra), { kind: "setNodeText", node: "a", text: "B" }).bytes)

		expect(after).toContain('<dgm:pt modelId="u" type="pres"><dgm:prSet custT="1"/><x:y xmlns:x="urn:x"/></dgm:pt>')
	})
})

describe("SmartArt find and replace", () => {
	const matcher = (query: string, caseSensitive = false) =>
		matcherOf({ query, caseSensitive }) as NonNullable<ReturnType<typeof matcherOf>>

	it("searches the text points in data order, paragraphs joined by a line feed", () => {
		expect(diagramFindTexts(FLAT)).toEqual(["Alpha", "Beta", "Gamma"])
	})

	it("replaces every match, case-insensitively, counting them", () => {
		const result = editDiagramData(FLAT, { kind: "replace", matcher: matcher("a"), replacement: "4" })

		expect(result).toMatchObject({ kind: "edited", replaced: 5 })
		expect(diagramFindTexts(parseXml((result as { bytes: Uint8Array }).bytes))).toEqual(["4lph4", "Bet4", "G4mm4"])
	})

	it("replaces only the match named, refusing it stale once gone", () => {
		const one = edited(FLAT, { kind: "replace", matcher: matcher("a"), replacement: "_", match: [2, 4, 5] })

		expect(diagramFindTexts(one)).toEqual(["Alpha", "Beta", "Gamm_"])
		expect(editDiagramData(one, { kind: "replace", matcher: matcher("a"), replacement: "_", match: [2, 4, 5] })).toMatchObject({
			reason: "stale"
		})
	})

	it("replaces across runs of one paragraph with the first run's formatting, never across a field or a paragraph", () => {
		const runs = doc(
			data([{ id: "a", text: "x" }]).replace(
				"<a:p><a:r><a:t>x</a:t></a:r></a:p>",
				'<a:p><a:r><a:rPr b="1"/><a:t>He</a:t></a:r><a:r><a:rPr i="1"/><a:t>llo W</a:t></a:r><a:fld id="f" type="slidenum"><a:t>7</a:t></a:fld></a:p><a:p><a:r><a:t>orld</a:t></a:r></a:p>'
			)
		)

		const greeting = edited(runs, { kind: "replace", matcher: matcher("hello"), replacement: "Bye" })
		const text = decodeUtf8(greeting.bytes)

		expect(diagramFindTexts(greeting)).toEqual(["Bye W7\norld"])
		expect(text).toContain('<a:r><a:rPr b="1"/><a:t>Bye</a:t></a:r><a:r><a:rPr i="1"/><a:t> W</a:t></a:r>')
		expect(editDiagramData(runs, { kind: "replace", matcher: matcher("w7"), replacement: "-" }).kind).toBe("unchanged")
		expect(editDiagramData(runs, { kind: "replace", matcher: matcher("7\no"), replacement: "-" }).kind).toBe("unchanged")
	})

	it("drops the drawing cache on every edit", () => {
		const cached = doc(
			data([{ id: "a", text: "A" }]).replace(
				"</dgm:cxnLst>",
				`</dgm:cxnLst><dgm:extLst><a:ext uri="${DATA_MODEL_EXT_URI}"><dsp:dataModelExt xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" relId="rId9" minVer="x"/></a:ext></dgm:extLst>`
			)
		)

		const after = edited(cached, { kind: "setNodeText", node: "a", text: "B" })

		// Detached (nothing draws the stale cache), the relationship kept for the writer.
		expect(decodeUtf8(after.bytes)).toContain('relId=""')
		expect(detachedDrawingRelId(after)).toBe("rId9")
		expect(detachedDrawingRelId(edited(after, { kind: "setNodeText", node: "a", text: "C" }))).toBe("rId9")
		expect(decodeUtf8(withDrawingReference(after, "rId3"))).toMatch(/<a:ext [^>]*><dsp:dataModelExt [^>]*relId="rId3"/u)
		expect(decodeUtf8(withDrawingReference(after, undefined))).not.toContain("dataModelExt")
	})
})

describe("SmartArt definitions and new diagrams", () => {
	it("switches the layout: the doc point names it and the presentation points go", () => {
		const withPres = doc(data([{ id: "a", text: "A" }], [{ id: "pa", prSet: 'presName="box" presAssocID="a"' }], 'loTypeId="old"'))
		const after = edited(withPres, { kind: "setDefinition", which: "layout", uniqueId: "urn:new", category: "list" })
		const model = parseDataModel(after)

		expect(model.pres).toHaveLength(0)
		expect(decodeUtf8(after.bytes)).toContain('loTypeId="urn:new"')
		expect(decodeUtf8(after.bytes)).toContain('loCatId="list"')
		expect(outline(after)).toEqual(["-A"])
	})

	it("switches style and colours, keeping the presentation points", () => {
		const withPres = doc(data([{ id: "a", text: "A" }], [{ id: "pa", prSet: 'presName="box" presAssocID="a"' }]))
		const after = edited(edited(withPres, { kind: "setDefinition", which: "style", uniqueId: "urn:s" }), {
			kind: "setDefinition",
			which: "colors",
			uniqueId: "urn:c"
		})

		expect(parseDataModel(after).pres).toHaveLength(1)
		expect(decodeUtf8(after.bytes)).toContain('qsTypeId="urn:s"')
		expect(decodeUtf8(after.bytes)).toContain('csTypeId="urn:c"')
	})

	it("builds a new diagram from texts, leading tabs as levels", () => {
		const created = doc(newDiagramData(["One", "\tOne.1", "\t\tdeep", "Two"], { layout: { uniqueId: "urn:l", category: "list" } }))

		expect(outline(created)).toEqual(["-One", "--One.1", "---deep", "-Two"])
		expect(decodeUtf8(created.bytes)).toContain('loTypeId="urn:l"')
	})

	it("reads a definition's uniqueId and category", () => {
		expect(
			definitionIds(
				doc(
					'<x:layoutDef xmlns:x="http://schemas.openxmlformats.org/drawingml/2006/diagram" uniqueId="u"><x:catLst><x:cat type="list" pri="1"/></x:catLst></x:layoutDef>'
				)
			)
		).toEqual({ uniqueId: "u", category: "list" })
	})

	it("names the drawing written at save in the data part's extLst", () => {
		const text = decodeUtf8(withDrawingReference(FLAT, "rId7"))

		expect(text).toContain('relId="rId7"')
		expect(parseDataModel(parseXml(encodeUtf8(text))).points.size).toBe(parseDataModel(FLAT).points.size)
	})
})
