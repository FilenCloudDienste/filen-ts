import { describe, expect, it } from "vitest"
import { CellFlag, type SheetCommandResult, type SheetRange, type SheetSessionApi } from "../core/sheet/protocol"
import type { Fixture } from "./xlsxWriteFixtures"
import { firstTile, openFixture, tileEntry } from "./sheetSessionFixtures"

// A paste of the session's own copy keeps each cell's type, as Excel's Paste All does; a values paste writes the
// cells' values at full precision, without their formats.

const STYLES =
	'<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
	'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
	'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
	'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
	'<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
	'<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
	'<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
	'<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
	'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'

const text = (ref: string, value: string, style = 0): string =>
	`<c r="${ref}" s="${String(style)}" t="inlineStr"><is><t xml:space="preserve">${value}</t></is></c>`

const FIXTURE: Fixture = {
	styles: STYLES,
	sheets: [
		{
			name: "One",
			body:
				'<sheetData><row r="1">' +
				text("A1", "007") +
				text("B1", "TRUE") +
				text("C1", "#N/A") +
				text("D1", "1/2/2025") +
				text("E1", "'quoted") +
				text("F1", "42", 2) +
				'<c r="G1" s="1"><v>3.14159</v></c>' +
				'<c r="H1" s="3"><v>45731</v></c>' +
				'<c r="I1"><f>G1*2</f><v>6.28318</v></c>' +
				'<c r="J1"><v>5</v></c>' +
				'</row><row r="3"><c r="J3" s="2"/></row></sheetData>'
		}
	]
}

function changed(result: SheetCommandResult): void {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason}`)
}

async function copyPaste(
	session: SheetSessionApi,
	sheet: number,
	range: SheetRange,
	at: { row: number; col: number },
	values: boolean
): Promise<void> {
	const copy = await session.query("copy", { sheet, range, cut: false })

	if (!("clip" in copy)) throw new Error("copy refused")

	changed(await session.command({ type: "clipboard.paste", sheet, at, text: copy.text, clip: copy.clip, ...(values && { values }) }))
}

const TYPED = CellFlag.NUMBER | CellFlag.BOOLEAN | CellFlag.ERROR

describe("sheet session: pasting the session's own copy", () => {
	it("keeps text that reads as a number, boolean, error or date as text", async () => {
		const { session, info } = await openFixture(FIXTURE)
		const one = info.sheets[0]!.id

		session.configure({ locale: { decimal: ".", group: ",", argument: ",", dateOrder: "mdy" } })
		await copyPaste(session, one, { startRow: 0, startCol: 0, endRow: 0, endCol: 5 }, { row: 2, col: 0 }, false)

		const tile = await firstTile(session, one)

		for (const [col, shown] of ["007", "TRUE", "#N/A", "1/2/2025", "'quoted", "42"].entries()) {
			const entry = tileEntry(tile, 2, col)

			expect(entry?.text).toBe(shown)
			expect((entry?.flags ?? 0) & TYPED).toBe(0)
		}

		session.close()
	})

	it("reads an entry by the format it pastes, not the format it lands on", async () => {
		const { session, info } = await openFixture(FIXTURE)
		const one = info.sheets[0]!.id

		// J1 holds 5 in General; J3 is formatted as Text.
		await copyPaste(session, one, { startRow: 0, startCol: 9, endRow: 0, endCol: 9 }, { row: 2, col: 9 }, false)

		const entry = tileEntry(await firstTile(session, one), 2, 9)

		expect(entry?.text).toBe("5")
		expect((entry?.flags ?? 0) & CellFlag.NUMBER).toBe(CellFlag.NUMBER)
		session.close()
	})
})

describe("sheet session: pasting values of the session's own copy", () => {
	it("writes the values at full precision without formats, and formula results", async () => {
		const { session, info } = await openFixture(FIXTURE)
		const one = info.sheets[0]!.id

		await copyPaste(session, one, { startRow: 0, startCol: 0, endRow: 0, endCol: 8 }, { row: 4, col: 0 }, true)

		const tile = await firstTile(session, one)
		const at = (col: number) => tileEntry(tile, 4, col)

		// 3.14159 shown "3.14" through 0.00 pastes in full, in General.
		expect(at(6)?.text).toBe("3.14159")
		expect(at(6)?.style).toBe(at(0)?.style)
		// A date pastes as its serial.
		expect(at(7)?.text).toBe("45731")
		expect((at(7)?.flags ?? 0) & CellFlag.NUMBER).toBe(CellFlag.NUMBER)
		// A formula pastes as its result.
		expect(at(8)?.text).toBe("6.28318")
		expect((at(8)?.flags ?? 0) & CellFlag.FORMULA).toBe(0)
		// Text stays text, the Text-formatted "42" too.
		expect(at(0)?.text).toBe("007")
		expect((at(0)?.flags ?? 0) & TYPED).toBe(0)
		expect(at(5)?.text).toBe("42")
		expect((at(5)?.flags ?? 0) & TYPED).toBe(0)
		session.close()
	})

	it("treats a cut as a copy: the source stays", async () => {
		const { session, info } = await openFixture(FIXTURE)
		const one = info.sheets[0]!.id
		const copy = await session.query("copy", { sheet: one, range: { startRow: 0, startCol: 6, endRow: 0, endCol: 6 }, cut: true })

		if (!("clip" in copy)) throw new Error("copy refused")

		changed(
			await session.command({
				type: "clipboard.paste",
				sheet: one,
				at: { row: 6, col: 0 },
				text: copy.text,
				clip: copy.clip,
				values: true
			})
		)

		const tile = await firstTile(session, one)

		expect(tileEntry(tile, 0, 6)?.text).toBe("3.14")
		expect(tileEntry(tile, 6, 0)?.text).toBe("3.14159")
		session.close()
	})
})
