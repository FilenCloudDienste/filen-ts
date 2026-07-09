import { describe, expect, it } from "vitest"
import { seededValueOnOpen } from "@/components/dialogs/inputDialog.logic"

describe("seededValueOnOpen (InputDialog initialValue seeding)", () => {
	it("seeds the initialValue on the closed-to-open transition", () => {
		expect(seededValueOnOpen(true, false, "report.pdf")).toBe("report.pdf")
	})

	it("seeds an empty string when no initialValue is given (New Directory's own caller)", () => {
		expect(seededValueOnOpen(true, false, "")).toBe("")
	})

	it("does not reseed while already open", () => {
		expect(seededValueOnOpen(true, true, "report.pdf")).toBeNull()
	})

	it("does not reseed on the open-to-closed transition", () => {
		expect(seededValueOnOpen(false, true, "report.pdf")).toBeNull()
	})

	it("does not reseed while already closed", () => {
		expect(seededValueOnOpen(false, false, "report.pdf")).toBeNull()
	})

	it("reseeds to a different initialValue on a fresh open (rename retargeted to another item without unmounting)", () => {
		expect(seededValueOnOpen(true, false, "second-item.pdf")).toBe("second-item.pdf")
	})
})
