import { describe, expect, it } from "vitest"
import {
	fieldEditable,
	planSave,
	PDF_DESKTOP_MEMORY,
	PDF_MOBILE_MEMORY,
	PDF_UNRESTRICTED,
	PDF_UNSIGNED,
	toolAvailability,
	type PdfSaveInput,
	type PdfSignatureState
} from "../../core/pdfedit"

const MIB = 1024 * 1024
const APPROVED: PdfSignatureState = { fields: ["Signature1"], certification: null, locks: [] }

function input(overrides: Partial<PdfSaveInput>): PdfSaveInput {
	return {
		inputBytes: 2 * MIB,
		signatures: PDF_UNSIGNED,
		changes: ["formFill"],
		invalidateConfirmed: false,
		poisoned: false,
		memory: PDF_DESKTOP_MEMORY,
		...overrides
	}
}

describe("planSave", () => {
	it("never saves an unsigned document incrementally", () => {
		for (const changes of [[], ["formFill"], ["annotate"], ["pages"], ["content"]] as const) {
			const plan = planSave(input({ changes }))

			expect(plan.mode).toBe("full")
			expect(plan.options).toContain("garbage=yes")
			expect(plan.options).not.toContain("incremental")
			expect(plan.refuse).toBeNull()
			expect(plan.invalidates).toEqual([])
		}
	})

	it("saves a signed document incrementally when its signers allowed every change", () => {
		const plan = planSave(input({ signatures: APPROVED, changes: ["formFill", "annotate", "sign"] }))

		expect(plan.mode).toBe("incremental")
		expect(plan.options).toContain("incremental")
		expect(plan.options).not.toContain("objstms")
	})

	it("rewrites a signed document whose changes its signers did not allow, after asking", () => {
		const asked = planSave(input({ signatures: APPROVED, changes: ["formFill", "pages"] }))

		expect(asked.mode).toBe("full")
		expect(asked.invalidates).toEqual(["Signature1"])
		expect(asked.refuse).toBe("invalidatesSignatures")
		expect(planSave(input({ signatures: APPROVED, changes: ["pages"], invalidateConfirmed: true })).refuse).toBeNull()
	})

	it("follows the certification level", () => {
		const certified = (certification: 1 | 2 | 3): PdfSignatureState => ({ fields: ["Cert"], certification, locks: [] })

		expect(planSave(input({ signatures: certified(1), changes: ["formFill"] })).mode).toBe("full")
		expect(planSave(input({ signatures: certified(2), changes: ["formFill", "sign"] })).mode).toBe("incremental")
		expect(planSave(input({ signatures: certified(2), changes: ["annotate"] })).mode).toBe("full")
		expect(planSave(input({ signatures: certified(3), changes: ["annotate"] })).mode).toBe("incremental")
	})

	it("refuses a save over the memory budget and a poisoned engine's", () => {
		expect(planSave(input({ inputBytes: 200 * MIB })).refuse).toBe("overBudget")
		expect(planSave(input({ inputBytes: 100 * MIB, memory: PDF_MOBILE_MEMORY })).refuse).toBe("overBudget")
		expect(planSave(input({ inputBytes: PDF_DESKTOP_MEMORY.editMaxBytes })).refuse).toBeNull()
		expect(planSave(input({ poisoned: true })).refuse).toBe("poisoned")
	})
})

describe("toolAvailability", () => {
	it("offers everything on an unsigned, unrestricted document", () => {
		expect(Object.values(toolAvailability(PDF_UNSIGNED, PDF_UNRESTRICTED)).every(block => block === null)).toBe(true)
	})

	it("follows the signature matrix", () => {
		const approval = toolAvailability(APPROVED, PDF_UNRESTRICTED)

		expect(approval).toMatchObject({
			formFill: null,
			annotate: null,
			sign: null,
			pages: "signed",
			content: "signed",
			security: "signed"
		})

		const p1 = toolAvailability({ fields: ["C"], certification: 1, locks: [] }, PDF_UNRESTRICTED)

		expect(p1).toMatchObject({ formFill: "signed", annotate: "signed", sign: "signed" })
	})

	it("honours an author's restrictions until the owner password unlocks them", () => {
		const restricted = { owner: false, print: true, edit: false, annotate: false, form: true, assemble: false }
		const tools = toolAvailability(PDF_UNSIGNED, restricted)

		expect(tools).toMatchObject({
			formFill: null,
			annotate: "restricted",
			pages: "restricted",
			content: "restricted",
			security: "restricted"
		})
		expect(toolAvailability(PDF_UNSIGNED, { ...restricted, owner: true }).content).toBeNull()
	})

	it("keeps locked fields from being filled", () => {
		const locked: PdfSignatureState = { fields: ["S"], certification: null, locks: [{ action: "Include", fields: ["name"] }] }

		expect(fieldEditable(locked, "name")).toBe(false)
		expect(fieldEditable(locked, "name.first")).toBe(false)
		expect(fieldEditable(locked, "address")).toBe(true)
		expect(fieldEditable(PDF_UNSIGNED, "name")).toBe(true)
	})
})
