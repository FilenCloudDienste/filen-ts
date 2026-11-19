import { describe, expect, it } from "vitest"
import { macroButtonText, shownFieldText } from "../core/docx/layout/fields"
import { docxWordCount, type DocxWordCount } from "../core/docx/paged/queries"
import { Item, RevisionView } from "../core/docx/model/kinds"
import type { StoryPart } from "../core/docx/model/part"
import { buildDocx } from "./docxSynthetic"
import { BODY, SHOWN, char, instr, para, run } from "./docxMacroButtonFixtures"
import { loadDocx } from "./layoutFixtures"
import { pagedEditor } from "./pagedFixtures"
import { budget, cpuMs } from "./timing"

describe("MACROBUTTON fields", () => {
	it("read their display text from the instruction", () => {
		expect(macroButtonText(' MACROBUTTON  synchronize "Sync contents" ')).toBe("Sync contents")
		expect(macroButtonText(" MACROBUTTON  synchronize Without result ")).toBe("Without result")
		expect(macroButtonText('macrobutton "My macro" "say \\"hi\\"" \\* MERGEFORMAT')).toBe('say "hi"')
		expect(macroButtonText(" MACROBUTTON NoMacro ")).toBe("")
		expect(macroButtonText(" MACROBUTTONS x y")).toBeUndefined()
		expect(macroButtonText(" PAGE ")).toBeUndefined()
		expect(shownFieldText("*", " MACROBUTTON a b ")).toBe("*")
		expect(shownFieldText("", " MACROBUTTON a b ")).toBe("b")
		expect(shownFieldText("", " PAGE ")).toBe("")
	})

	it("count and read as text what they show", async () => {
		const bytes = buildDocx({ body: BODY })
		const { model } = await loadDocx(bytes)
		const part = model.parts[model.stories[0]?.part ?? -1]

		if (part === undefined) throw new Error("no body part")

		const texts: string[] = []

		for (let item = 0; item < part.kinds.length; item++) if (part.kinds[item] === Item.Paragraph) texts.push(part.paragraphText(item))

		expect(texts).toEqual(SHOWN)

		// A count as of the same text in plain runs.
		const counted = async (source: Uint8Array): Promise<DocxWordCount> => {
			const { editor } = await pagedEditor(source)
			const count = await docxWordCount(editor)

			editor.dispose()

			return count
		}

		expect(await counted(bytes)).toEqual(await counted(buildDocx({ body: SHOWN.map(text => para(run(text))).join("") })))
	})

	it("report the text length before each item, a field's display text before the item after it", async () => {
		const body =
			BODY +
			para(
				run("x") + char("begin") + instr(" MACROBUTTON a ab ") + char("end") + '<w:bookmarkStart w:id="1" w:name="m"/>' + run("y")
			) +
			para(run("x") + '<w:fldSimple w:instr=" MACROBUTTON a ab "/><w:bookmarkStart w:id="2" w:name="s"/>' + run("y"))
		const part = await bodyPart(buildDocx({ body }))
		const views = [RevisionView.Final, RevisionView.Original, RevisionView.Markup]

		for (let item = 0; item < part.kinds.length; item++) {
			if (part.kinds[item] !== Item.Paragraph) continue

			for (const view of views) {
				const offsets = new Int32Array(part.end(item) - item + 1)
				const text = part.paragraphText(item, view, offsets)

				expect(text).toBe(part.paragraphText(item, view))
				expect(offsets[offsets.length - 1]).toBe(text.length)

				for (let k = 1; k < offsets.length; k++) expect(offsets[k] ?? 0).toBeGreaterThanOrEqual(offsets[k - 1] ?? 0)
			}
		}

		// The bookmark after each field sits after its display text.
		for (let item = 0; item < part.kinds.length; item++) {
			if (part.kinds[item] !== Item.BookmarkStart) continue

			let paragraph = item

			while (part.kinds[paragraph] !== Item.Paragraph) paragraph = part.parent(paragraph)

			const offsets = new Int32Array(part.end(paragraph) - paragraph + 1)

			expect(part.paragraphText(paragraph, RevisionView.Final, offsets)).toBe("xaby")
			expect(offsets[item - paragraph]).toBe(3)
		}
	})

	it("read an unterminated field's display text from its instruction alone, in time linear in the paragraphs", async () => {
		const count = 4000
		const part = await bodyPart(
			buildDocx({
				body:
					para(char("begin") + instr(" MACROBUTTON a Separated ") + char("separate") + run("later")) +
					Array.from({ length: count }, (_, k) =>
						para(char("begin") + instr(` MACROBUTTON a b${String(k)} `) + run("text"))
					).join("")
			})
		)

		expect(part.macroButtonDisplay(0)).toBe("Separated")

		const start = cpuMs()
		const shown: (string | undefined)[] = []

		for (let field = 1; field < part.fields.count; field++) shown.push(part.macroButtonDisplay(field))

		// Scanning each to the end of the part took seconds.
		expect(cpuMs() - start).toBeLessThan(budget(250))
		expect(shown).toEqual(Array.from({ length: count }, (_, k) => `b${String(k)}`))
	})
})

async function bodyPart(bytes: Uint8Array): Promise<StoryPart> {
	const { model } = await loadDocx(bytes)
	const part = model.parts[model.stories[0]?.part ?? -1]

	if (part === undefined) throw new Error("no body part")

	return part
}
