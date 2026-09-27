import { describe, expect, it } from "vitest"
import { layerKeyFor, resizable, sizesInFile } from "@/features/spreadsheet/lib/sizeRouting.logic"

describe("sizesInFile", () => {
	it("is only an editable workbook", () => {
		expect(sizesInFile("xlsx", "writable", true)).toBe(true)
		expect(sizesInFile("xlsx", "writable", false)).toBe(false)
		expect(sizesInFile("xlsx", "checking", false)).toBe(false)
		expect(sizesInFile("xlsx", "readOnly", false)).toBe(false)
		expect(sizesInFile("csv", "writable", true)).toBe(false)
		expect(sizesInFile("xls", "readOnly", false)).toBe(false)
	})
})

describe("layerKeyFor", () => {
	it("keys by the stable id, and by the document for the session without one", () => {
		expect(layerKeyFor("stable-1", "doc-1")).toEqual({ kind: "stable", id: "stable-1" })
		expect(layerKeyFor(undefined, "doc-1")).toEqual({ kind: "session", id: "doc-1" })
	})
})

describe("resizable", () => {
	// A workbook still being proven may yet keep its sizes in the file: a size set meanwhile would land
	// beside it and snap back once the verdict does.
	it("waits out the proof of a workbook that may become editable", () => {
		expect(resizable("xlsx", "checking", true)).toBe(false)
		expect(resizable("xlsx", "checking", false)).toBe(true)
		expect(resizable("xlsx", "writable", true)).toBe(true)
		expect(resizable("xlsx", "readOnly", true)).toBe(true)
		expect(resizable("csv", "writable", true)).toBe(true)
		expect(resizable("xls", "readOnly", false)).toBe(true)
	})
})
