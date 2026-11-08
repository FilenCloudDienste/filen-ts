import { beforeEach, describe, expect, it, vi } from "vitest"
import { FieldKind, fieldInfo } from "../core/docx/layout/fields"
import { buildDocx } from "./docxSynthetic"
import { layOut, pageLines } from "./layoutFixtures"

// DATE and TIME show the time the document is opened (Word's "Update automatically"); locked fields and the
// document-property dates keep the result Word stored.

const CLOCK = Date.UTC(2026, 9, 12, 14, 5, 9)

beforeEach(() => {
	vi.stubEnv("TZ", "UTC")
})

function complex(instruction: string, result: string, options: { lock?: boolean; rPr?: string } = {}): string {
	const rPr = options.rPr ?? ""
	const begin = `<w:fldChar w:fldCharType="begin"${options.lock === true ? ' w:fldLock="true"' : ""}/>`

	return (
		`<w:r>${rPr}${begin}</w:r><w:r>${rPr}<w:instrText xml:space="preserve">${instruction}</w:instrText></w:r>` +
		`<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr}<w:t>${result}</w:t></w:r><w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`
	)
}

function simple(instruction: string, result: string, lock = false): string {
	return `<w:fldSimple w:instr="${instruction.replaceAll('"', "&quot;")}"${lock ? ' w:fldLock="1"' : ""}><w:r><w:t>${result}</w:t></w:r></w:fldSimple>`
}

async function shown(paragraphs: readonly string[], date: number | undefined = CLOCK): Promise<string[]> {
	const body = paragraphs.map(content => `<w:p>${content}</w:p>`).join("")
	const layout = await layOut(buildDocx({ body }), date === undefined ? {} : { date })

	return pageLines(layout, 0).map(line => line.text.trim())
}

describe("DATE and TIME fields as laid out", () => {
	it("classifies DATE and TIME only, and keeps a locked one's result", () => {
		expect(fieldInfo(' DATE \\@ "d MMMM yyyy" ').kind).toBe(FieldKind.DATE)
		expect(fieldInfo(" time ").kind).toBe(FieldKind.TIME)

		for (const type of ["CREATEDATE", "SAVEDATE", "PRINTDATE", "EDITTIME", "DATEX"])
			expect(fieldInfo(` ${type} `).kind).toBe(FieldKind.OTHER)
	})

	it("shows the clock's date and time in place of a stale stored result", async () => {
		expect(
			await shown([
				complex(' DATE \\@ "d MMMM yyyy" ', "1 January 2000"),
				complex(" DATE ", "1/1/2000"),
				complex(' TIME \\@ "HH:mm:ss" ', "09:00:00"),
				complex(" TIME ", "9:00 AM"),
				complex(' DATE \\@ "MMMM" \\* Upper ', "JANUARY"),
				simple(' DATE \\@ "yyyy-MM-dd" ', "2000-01-01")
			])
		).toEqual(["12 October 2026", "10/12/2026", "14:05:09", "2:05 PM", "OCTOBER", "2026-10-12"])
	})

	it("names months in the field's language (w:lang)", async () => {
		expect(
			await shown([complex(' DATE \\@ "d. MMMM yyyy" ', "1. Januar 2000", { rPr: '<w:rPr><w:lang w:val="de-DE"/></w:rPr>' })])
		).toEqual(["12. Oktober 2026"])
	})

	it("keeps the stored result of locked fields and of CREATEDATE, SAVEDATE and PRINTDATE", async () => {
		expect(
			await shown([
				complex(' DATE \\@ "d MMMM yyyy" ', "1 January 2000", { lock: true }),
				simple(" TIME ", "9:00 AM", true),
				complex(' CREATEDATE \\@ "d MMMM yyyy" ', "2 January 2000"),
				complex(' SAVEDATE \\@ "d MMMM yyyy" ', "3 January 2000"),
				complex(' PRINTDATE \\@ "d MMMM yyyy" ', "4 January 2000")
			])
		).toEqual(["1 January 2000", "9:00 AM", "2 January 2000", "3 January 2000", "4 January 2000"])
	})

	it("reads the clock once when layout starts by default", async () => {
		const spy = vi.spyOn(Date, "now").mockReturnValue(CLOCK)

		try {
			expect(await shown([complex(" DATE ", "1/1/2000"), complex(" DATE ", "1/1/2000")], undefined)).toEqual([
				"10/12/2026",
				"10/12/2026"
			])
		} finally {
			spy.mockRestore()
		}
	})
})
