import { describe, expect, it } from "vitest"
import { buildOtpauthUri, canDismissRecoveryKeyPanel } from "@/features/settings/components/security/twoFactor.logic"

describe("buildOtpauthUri", () => {
	it("percent-encodes the Filen:<email> label and the secret into a scannable otpauth URI", () => {
		expect(buildOtpauthUri("user+test@example.com", "JBSWY3DPEHPK3PXP")).toBe(
			"otpauth://totp/Filen%3Auser%2Btest%40example.com?secret=JBSWY3DPEHPK3PXP"
		)
	})
})

describe("canDismissRecoveryKeyPanel (2FA enable → recovery-panel gating)", () => {
	it("blocks a dismissal attempt before the user has confirmed they saved the key", () => {
		expect(canDismissRecoveryKeyPanel(false, false)).toBe(false)
	})

	it("allows the dismissal once the user has confirmed", () => {
		expect(canDismissRecoveryKeyPanel(false, true)).toBe(true)
	})

	it("a true (opening) transition is never blocked, confirmed or not", () => {
		expect(canDismissRecoveryKeyPanel(true, false)).toBe(true)
		expect(canDismissRecoveryKeyPanel(true, true)).toBe(true)
	})
})
