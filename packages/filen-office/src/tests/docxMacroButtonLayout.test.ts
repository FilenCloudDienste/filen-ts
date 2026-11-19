import { describe, expect, it } from "vitest"
import { saveDocx } from "@filen/office/core/docx/write"
import { macroButtonText } from "../core/docx/model/macroButton"
import { buildDocx } from "./docxSynthetic"
import { BODY, SHOWN, char, instr, para, run } from "./docxMacroButtonFixtures"
import { layOut, pageLines } from "./layoutFixtures"
import { pagedEditor } from "./pagedFixtures"
import { budget, cpuMs } from "./timing"

describe("MACROBUTTON fields as laid out", () => {
	it("show their display text where they have no result, and their result where they have one", async () => {
		const layout = await layOut(buildDocx({ body: BODY }))

		expect(pageLines(layout, 0).map(line => line.text)).toEqual(SHOWN)
	})

	it("show the same in the editor, which neither runs them nor changes them on update or save", async () => {
		const bytes = buildDocx({ body: BODY })
		const { editor, pkg, context } = await pagedEditor(bytes)

		await editor.whenSettled()
		expect(pageLines(editor.layout, 0).map(line => line.text)).toEqual(SHOWN)

		// Their codes when the codes are shown.
		editor.setFieldCodes(true)
		await editor.whenSettled()
		expect(pageLines(editor.layout, 0)[1]?.text).toBe("{ MACROBUTTON  synchronize Without result }")
		editor.setFieldCodes(false)

		const doc = editor.session.state.doc

		await editor.execute({ type: "field.updateAll" })
		await editor.whenSettled()
		expect(editor.session.state.doc).toBe(doc)
		expect(pageLines(editor.layout, 0).map(line => line.text)).toEqual(SHOWN)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(saved.bytes).toEqual(bytes)
		editor.dispose()
	})
})

describe("MACROBUTTON display text", () => {
	it("strips trailing switches in time linear in the instruction", () => {
		// "\\*a" repeated before a plain word: what a regular expression of repeated groups backtracks on.
		const crafted = (n: number): string => `MACROBUTTON m ${"\\*a".repeat(n)} b`
		const started = cpuMs()

		expect(macroButtonText(crafted(26))).toBe("\\*a".repeat(26) + " b")
		expect(macroButtonText(crafted(20_000))?.length).toBe(60_002)
		expect(cpuMs() - started).toBeLessThan(budget(250))
		expect(macroButtonText(" MACROBUTTON m Text \\* MERGEFORMAT ")).toBe("Text")
		expect(macroButtonText(" MACROBUTTON m Text\\*Upper \\*  Lower ")).toBe("Text")
	})

	it("shows the results of fields nested in its display text, as the instruction's value holds them", async () => {
		const nested = (inner: string): string => char("begin") + instr(" MACROBUTTON FollowHLink ") + inner + char("end")
		const hyperlink =
			char("begin") + instr(' HYPERLINK "https://filen.io" ') + char("separate") + run("Read the guidance") + char("end")
		const layout = await layOut(
			buildDocx({
				body:
					para(nested(hyperlink)) +
					para(nested(run("before ") + hyperlink)) +
					// A nested field without a result adds nothing; its instruction is never shown.
					para(char("begin") + instr(" MACROBUTTON m Text ") + char("begin") + instr(" PAGE ") + char("end") + char("end"))
			})
		)

		expect(pageLines(layout, 0).map(line => line.text)).toEqual(["Read the guidance", "Read the guidance", "Text"])
	})

	it("lays out a document with a crafted MACROBUTTON promptly", async () => {
		const field = char("begin") + instr(`MACROBUTTON m ${"\\*a".repeat(26)} b`) + char("end")
		const started = performance.now()
		const layout = await layOut(buildDocx({ body: para(field) }))

		expect(pageLines(layout, 0)[0]?.text).toContain(" b")
		expect(performance.now() - started).toBeLessThan(budget(5000))
	})
})
