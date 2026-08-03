import { describe, expect, it } from "vitest"
import { readTwoFactorKind } from "@/features/auth/lib/twoFactorKinds"

describe("readTwoFactorKind", () => {
	it("reads a code-less first attempt as a two-factor rejection without a wrong code", () => {
		expect(readTwoFactorKind("Enter2fa")).toEqual({ wrongCode: false })
	})

	it("reads a rejected code as a two-factor rejection WITH a wrong code", () => {
		expect(readTwoFactorKind("Wrong2fa")).toEqual({ wrongCode: true })
	})

	it("is null for an unrelated SDK kind — the branch must not swallow other failures", () => {
		expect(readTwoFactorKind("BadRecoveryKey")).toBeNull()
	})

	it("is null for a kindless (non-SDK) error", () => {
		expect(readTwoFactorKind(undefined)).toBeNull()
	})
})
