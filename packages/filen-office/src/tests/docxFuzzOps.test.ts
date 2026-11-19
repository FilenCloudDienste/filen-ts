import { describe, expect, it } from "vitest"
import { docxSchema, REVISION_MARKS } from "../core/docx/edit/schema"
import { sessionOf } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { rng } from "./fuzz/config"
import { digestPage } from "./fuzz/digest"
import { baseOps, textPositions, typeSomewhere } from "./fuzz/ops/base"
import type { OpContext } from "./fuzz/ops/index"
import { layOut } from "./layoutFixtures"

// The fuzz harness's own choices: an op must find somewhere to act in every editable document.
describe("docx fuzz ops", () => {
	it("types into paragraphs that hold no text (a picture or a break alone) at their start and end", async () => {
		const session = await sessionOf({ body: '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + p("") })
		const doc = session.state.doc
		const first = doc.child(0)

		expect(first.textContent).toBe("")
		expect(textPositions(doc)).toEqual([1, first.nodeSize - 1, first.nodeSize + 1])
	})

	it("moves blocks untracked and leaves the document's tracking as it was", async () => {
		const session = await sessionOf({ body: [p("one"), p("two"), p("three"), p("four")].join("") })
		const review = session.context.review
		const move = baseOps.find(op => op.name === "blockMove")

		if (move === undefined) throw new Error("no blockMove")

		review.tracking = true
		session.context.identity.author = "Fuzz"

		const context: OpContext = {
			rand: rng(3),
			session,
			editor: undefined,
			numIds: [],
			styleIds: [],
			transact(_label, build) {
				const tr = session.state.tr

				return String(session.dispatch(build(tr) ?? tr))
			},
			execute: () => "false"
		}

		const texts = (): string[] => {
			const out: string[] = []

			session.state.doc.forEach(block => out.push(block.textContent))

			return out
		}
		const before = texts()
		const results: string[] = []

		// Until a move applies: a draw may pick a target inside the moved range (a no-op).
		for (let k = 0; k < 32 && !results.some(result => result.endsWith("-> true")); k++) results.push(await move.run(context))

		const after = texts()
		const revisionMarks = new Set(REVISION_MARKS.map(name => docxSchema.marks[name]))
		const tracked: string[] = []

		session.state.doc.descendants(node => {
			if (((node.attrs["revision"] as number | undefined) ?? 0) !== 0) tracked.push(`${node.type.name} revision`)

			for (const mark of node.marks) if (revisionMarks.has(mark.type)) tracked.push(mark.type.name)
		})

		expect(results.some(result => result.endsWith("-> true"))).toBe(true)
		expect(after).not.toEqual(before)
		expect(after.toSorted()).toEqual(before.toSorted())
		expect(tracked).toEqual([])
		expect(review.tracking).toBe(true)
	})

	it("types the self-test text where changes are tracked, as an author", async () => {
		const session = await sessionOf({ body: p("tracked text here"), settings: "<w:trackRevisions/>" })

		session.context.review.tracking = true

		expect(typeSomewhere(session, rng(5), "SELFTEST")).toBe(true)
		expect(session.state.doc.textContent).toContain("SELFTEST")
	})

	it("digests fills and borders, so two layouts drawing them differently differ", async () => {
		const cell = (fill: string): string =>
			`<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:fill="${fill}"/></w:tcPr>${p("cell")}</w:tc></w:tr></w:tbl>`
		const digest = async (fill: string): Promise<string> => {
			const layout = await layOut(buildDocx({ body: cell(fill) + p("") }))

			return digestPage(layout, layout.pages[0] ?? (undefined as never))
		}

		expect(await digest("FF0000")).not.toEqual(await digest("00FF00"))
	})
})
