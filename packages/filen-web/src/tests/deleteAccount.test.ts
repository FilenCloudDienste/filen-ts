import { describe, expect, it } from "vitest"
import { advanceDeleteAccountChain } from "@/features/settings/components/security/deleteAccount.logic"

describe("advanceDeleteAccountChain", () => {
	it("cancelling stage1 aborts the whole chain", () => {
		expect(advanceDeleteAccountChain("stage1", false, false)).toEqual({ status: "aborted" })
	})

	it("confirming stage1 always advances to stage2, regardless of two-factor state", () => {
		expect(advanceDeleteAccountChain("stage1", true, false)).toEqual({ status: "advance", stage: "stage2" })
		expect(advanceDeleteAccountChain("stage1", true, true)).toEqual({ status: "advance", stage: "stage2" })
	})

	it("cancelling stage2 aborts the whole chain (never falls back to stage1)", () => {
		expect(advanceDeleteAccountChain("stage2", false, true)).toEqual({ status: "aborted" })
	})

	it("confirming stage2 with two-factor enabled advances to the code step", () => {
		expect(advanceDeleteAccountChain("stage2", true, true)).toEqual({ status: "advance", stage: "code" })
	})

	it("confirming stage2 with two-factor disabled submits directly — no code step", () => {
		expect(advanceDeleteAccountChain("stage2", true, false)).toEqual({ status: "submit" })
	})
})
