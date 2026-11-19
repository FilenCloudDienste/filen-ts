import { describe, expect, it, vi } from "vitest"
import { DocxEditorSession } from "@filen/office/core/docx/edit"
import { saveDocx, writerProof, type DocxSaveFailure } from "@filen/office/core/docx/write"
import { DocxSaveError } from "../core/docx/write/failure"
import type { Out } from "../core/docx/write/markup"
import { StoryWriting, type WrittenContainer } from "../core/docx/write/story"
import { openBytes } from "./docxEditFixtures"
import { buildDocx } from "./docxSynthetic"

// Parses gate 2 runs while `counting`: the container check's are what the tests below look at.
const parses = vi.hoisted(() => ({ counting: false, count: 0 }))

vi.mock("../core/xml/index", async importOriginal => {
	const original = await importOriginal<typeof import("../core/xml/index")>()

	return {
		...original,
		parseXml: (...args: Parameters<typeof original.parseXml>) => {
			if (parses.counting) parses.count++

			return original.parseXml(...args)
		},
		parseXmlSliced: (...args: Parameters<typeof original.parseXmlSliced>) => {
			if (parses.counting) parses.count++

			return original.parseXmlSliced(...args)
		}
	}
})

const ROWS = 1_500
const ROW =
	'<w:tr><w:trPr><w:trHeight w:val="300"/></w:trPr>' +
	'<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc>' +
	'<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/><w:shd w:val="clear" w:fill="EEEEEE"/></w:tcPr><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr>'
const TABLE =
	'<w:tbl><w:tblPr><w:tblW w:w="4000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
	ROW.repeat(ROWS) +
	"</w:tbl>"

// A save of the table pasted after itself, in slices: how many parses gate 2 ran and how often it paused.
async function pastedTable(): Promise<{ pauses: number; parsed: number; refusal: DocxSaveFailure | undefined }> {
	const opened = await openBytes(buildDocx({ body: TABLE + "<w:p><w:r><w:t>end</w:t></w:r></w:p>" }))
	const session = new DocxEditorSession(opened.context, { proof: writerProof(opened.context) })
	let pauses = 0

	session.dispatch(session.state.tr.insert(session.state.doc.content.size, session.state.doc.child(0)))
	parses.count = 0
	parses.counting = true

	try {
		await saveDocx(
			{ pkg: opened.pkg, context: opened.context, sessions: [session] },
			{
				slicing: {
					sliceMs: 0,
					now: () => performance.now(),
					pause: () => {
						pauses++

						return Promise.resolve()
					}
				}
			}
		)

		return { pauses, parsed: parses.count, refusal: undefined }
	} catch (error) {
		if (error instanceof DocxSaveError) return { pauses, parsed: parses.count, refusal: error.reason }

		throw error
	} finally {
		parses.counting = false
	}
}

describe("docx save verifier performance: copied containers", () => {
	// A pasted table writes a container for the table, its grid, every row and every cell; gate 2 parses them a
	// batch at a time, not one document each.
	it("checks a pasted table's containers in a few parses, pausing between them", { timeout: 60_000 }, async () => {
		const { pauses, parsed, refusal } = await pastedTable()

		expect(refusal).toBeUndefined()
		expect(pauses).toBeGreaterThan(0)
		// ~4,500 containers; one parse each would be thousands.
		expect(parsed).toBeLessThan(50)
	})

	it("still refuses one copied container that lost its properties", { timeout: 60_000 }, async () => {
		const copyProperties = StoryWriting.prototype.copyProperties
		let calls = 0

		// The 1,000th container is written without its properties but recorded as having them.
		vi.spyOn(StoryWriting.prototype, "copyProperties").mockImplementation(function (
			this: StoryWriting,
			out: Out,
			properties: readonly number[],
			strip: readonly string[]
		) {
			if (++calls !== 1_000) return copyProperties.call(this, out, properties, strip)

			copyProperties.call(this, out, [], strip)

			const containers: unknown = Reflect.get(this, "containers")

			if (!Array.isArray(containers)) throw new Error("No containers")

			const last = containers[containers.length - 1] as WrittenContainer

			containers[containers.length - 1] = { ...last, properties: properties.filter(property => property >= 0) }
		})

		try {
			expect((await pastedTable()).refusal).toBe("content")
			expect(calls).toBeGreaterThan(1_000)
		} finally {
			vi.restoreAllMocks()
		}
	})
})
