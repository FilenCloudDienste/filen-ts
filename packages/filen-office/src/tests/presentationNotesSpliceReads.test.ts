import { afterEach, describe, expect, it, vi } from "vitest"
import { PackageWriter } from "../core/pptx/write/parts"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { Changes, openDeck, save, slideNode } from "./pptxWriteFixtures"

// A save of a deck whose session made no notes part reads no unchanged slide's relationships for its notes: only a
// notes part the session made is ever taken out again.

afterEach(() => {
	vi.restoreAllMocks()
})

describe("spliceNotes", () => {
	it("reads no relationships of unchanged slides when the session made no notes part", async () => {
		const opened = await openDeck(
			buildPptx({
				slides: [1, 2, 3].map(n => ({
					shapes: sp(2, "TextBox 1", undefined, xfrm(0, 0, 100, 100), body(para(`Slide ${String(n)}`)))
				}))
			})
		)
		const first = slideNode(opened, 0)
		const shape = first.shapes[0]

		if (shape?.xfrm === undefined) throw new Error("no shape")

		shape.xfrm = { ...shape.xfrm, x: 500 }

		const loaded: string[] = []
		const load = PackageWriter.prototype.loadRelationships

		vi.spyOn(PackageWriter.prototype, "loadRelationships").mockImplementation(function (this: PackageWriter, source: string) {
			loaded.push(source.replace(/^\//u, ""))

			return load.call(this, source)
		})

		const saved = await save(opened, new Changes().shape(first.part, 2, { kind: "xfrm" }).build())

		expect(saved.outcome).toMatchObject({ kind: "written" })
		expect(loaded).not.toContain("ppt/slides/slide2.xml")
		expect(loaded).not.toContain("ppt/slides/slide3.xml")
	})
})
