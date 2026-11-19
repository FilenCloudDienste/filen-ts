import { describe, expect, it } from "vitest"
import { legacySheetPassword, sheetPasswordCheck } from "../core/xlsx/edit/protection"
import { hashProtectionPassword, verifyProtectionPassword } from "../dom/protection"
import { cells, openFixture, savedBytes, changeOf } from "./sheetSessionFixtures"
import { parts } from "./xlsxWriteFixtures"
import { budget } from "./timing"

// Sheet and workbook protection: honoured before any edit runs, set and taken off, and the passwords that guard
// them ([MS-OFFCRYPTO] §2.3.7.1 legacy verifier, §2.4.2.4 modern hash).

describe("protection passwords", () => {
	it("computes Excel's legacy 16-bit verifier", () => {
		// Known answers: Apache POI's CryptoFunctions.createXorVerifier1 and openpyxl's hash_password.
		expect(legacySheetPassword("password")).toBe("83AF")
		expect(legacySheetPassword("secret")).toBe("DAA7")
		expect(legacySheetPassword("")).toBe("")
	})

	it("checks a legacy hash at once and hands a modern one to the platform", () => {
		expect(sheetPasswordCheck({ legacy: "83AF" }, "password")).toEqual({ kind: "legacy", correct: true })
		expect(sheetPasswordCheck({ legacy: "83AF" }, "Password")).toEqual({ kind: "legacy", correct: false })
		expect(sheetPasswordCheck(null, "x")).toEqual({ kind: "none" })
		expect(
			sheetPasswordCheck({ algorithmName: "SHA-512", hashValue: "h", saltValue: "s", spinCount: 100000, legacy: "83AF" }, "x")
		).toEqual({
			kind: "modern",
			algorithm: "SHA-512",
			hash: "h",
			salt: "s",
			spinCount: 100000
		})
	})

	it("makes a modern hash the platform verifies", { timeout: 60_000 }, async () => {
		const hash = await hashProtectionPassword("Filen")

		expect(hash).toMatchObject({ algorithmName: "SHA-512", spinCount: 100_000 })

		const check = sheetPasswordCheck(hash, "Filen")

		if (check.kind !== "modern") throw new Error(check.kind)

		const input = {
			algorithm: "SHA-512" as const,
			hash: check.hash,
			salt: check.salt,
			spinCount: check.spinCount,
			input: "plain" as const
		}

		expect(await verifyProtectionPassword(input, "Filen")).toBe("correct")
		expect(await verifyProtectionPassword(input, "filen")).toBe("wrong")
	})

	it("refuses to spin a file's hash past the 10,000,000 spins Office supports, at once", async () => {
		const hash = {
			algorithm: "SHA-512" as const,
			hash: "A".repeat(86) + "==",
			salt: "AAAAAAAAAAAAAAAAAAAAAA==",
			input: "plain" as const
		}
		const started = performance.now()

		expect(await verifyProtectionPassword({ ...hash, spinCount: 4_000_000_000 }, "x")).toBe("unsupported")
		expect(await verifyProtectionPassword({ ...hash, spinCount: 10_000_001 }, "x")).toBe("unsupported")
		expect(await verifyProtectionPassword({ ...hash, spinCount: 1.5 }, "x")).toBe("unsupported")
		expect(await verifyProtectionPassword({ ...hash, spinCount: Number.NaN }, "x")).toBe("unsupported")
		expect(await verifyProtectionPassword({ ...hash, spinCount: -1 }, "x")).toBe("unsupported")
		expect(performance.now() - started).toBeLessThan(budget(1000))
	})

	it("stops a check when its signal aborts", async () => {
		const controller = new AbortController()
		const check = verifyProtectionPassword(
			{ algorithm: "SHA-512", hash: "A".repeat(86) + "==", salt: "AAAAAAAAAAAAAAAAAAAAAA==", spinCount: 10_000_000, input: "plain" },
			"x",
			{ signal: controller.signal }
		)

		setTimeout(() => {
			controller.abort()
		}, 20)

		await expect(check).rejects.toMatchObject({ code: "aborted" })
	})
})

describe("sheet session: sheet protection", () => {
	it("protects a sheet, then refuses locked cells and actions it does not allow; unprotected, both run", async () => {
		const { session, info, bytes } = await openFixture({
			sheets: [{ name: "One", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }]
		})
		const sheet = info.sheets[0]!.id
		const protectedChange = changeOf(
			await session.command({
				type: "sheet.protect",
				sheet,
				allows: ["selectLockedCells", "selectUnlockedCells", "insertRows"],
				hash: { legacy: "83AF" }
			})
		)

		expect(protectedChange.layouts[0]?.layout.protection?.hasPassword).toBe(true)
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain(
			// Objects and scenarios are protected unless allowed, as Excel writes them.
			'<sheetProtection password="83AF" sheet="1" objects="1" scenarios="1" insertRows="0"/>'
		)

		const edit = await session.command({ type: "cells.set", sheet, cells: cells([[0, 0, "2"]]) })
		const deleteRows = await session.command({ type: "axis.delete", sheet, axis: "rows", at: 0, count: 1 })
		const insertRows = await session.command({ type: "axis.insert", sheet, axis: "rows", at: 0, count: 1 })

		expect(edit.ok ? null : edit.refusal.reason).toBe("protectedSheet")
		expect(deleteRows.ok ? null : deleteRows.refusal).toEqual({ reason: "protectedSheet", detail: "deleteRows" })
		expect(insertRows.ok).toBe(true)

		const again = await session.command({ type: "sheet.protect", sheet, allows: [] })

		expect(again.ok ? null : again.refusal.reason).toBe("protectedSheet")
		expect(await session.query("protection.hash", { target: { sheet } })).toEqual({ legacy: "83AF" })

		changeOf(await session.command({ type: "sheet.unprotect", sheet }))
		changeOf(await session.command({ type: "cells.set", sheet, cells: cells([[0, 0, "2"]]) }))

		for (let k = 0; k < 4; k++) changeOf(await session.undo())

		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})
})

describe("sheet session: workbook protection", () => {
	it("locks the structure, refusing sheet edits, and keeps a revisions lock when taken off", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{ name: "One", body: "<sheetData/>" },
				{ name: "Two", body: "<sheetData/>" }
			]
		})
		const one = info.sheets[0]!.id

		changeOf(await session.command({ type: "workbook.protect", structure: true, windows: false }))
		expect(parts(await savedBytes(session))["xl/workbook.xml"]).toContain('<workbookProtection lockStructure="1"/>')

		const renamed = await session.command({ type: "sheet.rename", sheet: one, name: "Main" })
		const added = await session.command({ type: "sheet.add" })

		expect(renamed.ok ? null : renamed.refusal.reason).toBe("protectedWorkbook")
		expect(added.ok ? null : added.refusal.reason).toBe("protectedWorkbook")

		changeOf(await session.command({ type: "workbook.unprotect" }))
		changeOf(await session.command({ type: "sheet.rename", sheet: one, name: "Main" }))
		expect(parts(await savedBytes(session))["xl/workbook.xml"]).not.toContain("workbookProtection")
		session.close()

		const revisions = await openFixture({
			sheets: [{ name: "One", body: "<sheetData/>" }],
			workbookTail: '<workbookProtection lockStructure="1" lockRevision="1"/>'
		})

		changeOf(await revisions.session.command({ type: "workbook.unprotect" }))
		expect(parts(await savedBytes(revisions.session))["xl/workbook.xml"]).toContain('<workbookProtection lockRevision="1"/>')
		revisions.session.close()
	})
})

describe("sheet session: protection of a sheet still being parsed", () => {
	it("is in the layout an open answers, as the preview's tiles flag locked cells", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><sheetProtection sheet="1" selectLockedCells="1"/>'
				}
			]
		})

		expect(info.activeLayout.protection?.allows.has("selectLockedCells")).toBe(false)
		expect(info.activeLayout.protection?.allows.has("selectUnlockedCells")).toBe(true)
		session.close()
	})
})

describe("sheet session: protection undone", () => {
	it("keeps the source's unprotected sheetProtection element through protect and undo", async () => {
		// Excel keeps the Protect Sheet choices in an element without sheet="1" once a sheet is unprotected.
		const { session, info, bytes } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><sheetProtection formatCells="0" selectLockedCells="1"/>'
				}
			]
		})
		const one = info.sheets[0]!.id

		changeOf(await session.command({ type: "sheet.protect", sheet: one, allows: ["selectUnlockedCells"] }))
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain('sheet="1"')
		changeOf(await session.undo())

		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})

	it("drops a protecting element when the sheet is unprotected", async () => {
		const { session, info } = await openFixture({
			sheets: [{ name: "One", body: '<sheetData/><sheetProtection sheet="1" formatCells="0"/>' }]
		})

		changeOf(await session.command({ type: "sheet.unprotect", sheet: info.sheets[0]!.id }))
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).not.toContain("sheetProtection")
		session.close()
	})
})
