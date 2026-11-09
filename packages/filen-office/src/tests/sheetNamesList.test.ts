import { describe, expect, it } from "vitest"
import { buildFixture } from "./sheetSessionFixtures"
import { openAnnotated } from "./sheetNotesFixtures"

// names.list: the workbook's defined names for the app's name box, hidden ones left out.

const NAMED = buildFixture({
	sheets: [
		{ name: "One", body: "<sheetData/>" },
		{ name: "Two", body: "<sheetData/>" }
	],
	workbookTail:
		"<definedNames>" +
		'<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">One!$A$1:$B$4</definedName>' +
		'<definedName name="Local" localSheetId="1">Two!$C$3</definedName>' +
		'<definedName name="Wide">One!$A:$A</definedName>' +
		"</definedNames>"
})

describe("names.list", () => {
	it("lists each visible name with its scope and formula", async () => {
		const { session, sheets } = await openAnnotated(NAMED)

		expect(await session.query("names.list", {})).toEqual([
			{ name: "Local", sheet: sheets[1], formula: "Two!$C$3" },
			{ name: "Wide", sheet: null, formula: "One!$A:$A" }
		])
		session.close()
	})
})
