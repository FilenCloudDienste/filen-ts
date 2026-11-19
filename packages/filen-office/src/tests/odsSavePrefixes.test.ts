import { describe, expect, it, vi } from "vitest"
import { bytesSource } from "../core/opc/index"
import { openOds } from "../core/ods/open"
import type { SheetCommand } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { ODS_NS, odsBytes, odsDocument, shownRows, type OdsParts } from "./odsFixtures"
import { IMMEDIATE } from "./sheetSessionFixtures"

// The save's own guards behind the open-time one (writer.ts viewOnly, bypassed here): content whose tables or rows
// are under prefixes the writer does not match is never saved as if the edit were in it.

vi.mock(import("../core/ods/read/scan"), async original => ({
	...(await original()),
	misbound: () => false,
	reboundBelowRoot: () => false
}))

const TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
const CELL = '<t:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></t:table-cell>'

async function edited(parts: OdsParts): Promise<{ ok: boolean; rows: string[][] | null }> {
	const result = await inThreadSheetHost().open(
		odsBytes(parts),
		{ kind: "ods", slicing: IMMEDIATE, settings: { author: "Test" } },
		() => undefined
	)

	if (result.kind !== "opened") throw new Error(result.kind)

	const session = result.session
	const sheet = result.info.sheets[0]?.id ?? 0
	const command: SheetCommand = {
		type: "cells.set",
		sheet,
		cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: ["edited"] }
	}

	try {
		expect(await session.intent()).toEqual({ state: "writable" })
		expect((await session.command(command)).ok).toBe(true)

		const saved = await session.save()

		if (!saved.ok) return { ok: false, rows: null }

		const opened = await openOds(bytesSource(saved.bytes))

		if (!opened.ok) throw new Error(opened.message)

		const document = odsDocument(opened)

		await document.readyAllSheets()

		return { ok: true, rows: shownRows(document, 0) }
	} finally {
		session.close()
	}
}

describe("an ODS save under prefixes the writer does not match", () => {
	it("refuses content whose tables are under another prefix", async () => {
		const result = await edited({
			namespaces: `${ODS_NS} xmlns:t="${TABLE}"`,
			body: `<t:table t:name="S"><t:table-row>${CELL}</t:table-row></t:table>`
		})

		expect(result).toEqual({ ok: false, rows: null })
	})

	it("refuses content whose table is recognised but whose rows are under another prefix", async () => {
		const result = await edited({
			namespaces: `${ODS_NS} xmlns:t="${TABLE}"`,
			body: `<table:table table:name="S"><t:table-row>${CELL}</t:table-row></table:table>`
		})

		expect(result).toEqual({ ok: false, rows: null })
	})
})
