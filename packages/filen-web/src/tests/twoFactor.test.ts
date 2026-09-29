import { describe, expect, it } from "vitest"
import { buildOtpauthUri } from "@/features/settings/components/security/twoFactor.logic"

describe("buildOtpauthUri", () => {
	it("percent-encodes the Filen:<email> label and the secret into a scannable otpauth URI", () => {
		expect(buildOtpauthUri("user+test@example.com", "JBSWY3DPEHPK3PXP")).toBe(
			"otpauth://totp/Filen%3Auser%2Btest%40example.com?secret=JBSWY3DPEHPK3PXP"
		)
	})
})
