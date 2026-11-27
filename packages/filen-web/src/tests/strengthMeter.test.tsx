// @vitest-environment jsdom

// The weak tier states the exact rule ratePasswordStrength enforces, inside a polite live region.
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { isPasswordStrongEnough, PASSWORD_LONG_LENGTH, PASSWORD_MIN_LENGTH, ratePasswordStrength } from "@filen/shared"
import "@/lib/i18n"
import { StrengthMeter } from "@/features/auth/components/strengthMeter"

afterEach(() => {
	cleanup()
})

describe("StrengthMeter", () => {
	it("states the concrete requirement for a weak password in an aria-live region", () => {
		const { container } = render(<StrengthMeter tier="weak" />)
		const message = screen.getByText(/Use at least 10 characters/)

		expect(message.textContent).toBe(
			"Use at least 10 characters including two of: uppercase, lowercase, numbers, symbols. Or use 20 or more characters."
		)
		expect(message.closest("[aria-live]")?.getAttribute("aria-live")).toBe("polite")
		expect(container.querySelectorAll("[aria-live]")).toHaveLength(1)
	})

	it("keeps the live region mounted but empty for stronger tiers", () => {
		const { container } = render(<StrengthMeter tier="normal" />)

		expect(screen.queryByText(/Use at least/)).toBeNull()
		expect(container.querySelector("[aria-live]")?.textContent).toBe("")
	})

	it("matches the rule the rating enforces", () => {
		const twoClasses = "a".repeat(PASSWORD_MIN_LENGTH - 1) + "1"

		expect(PASSWORD_MIN_LENGTH).toBe(10)
		expect(PASSWORD_LONG_LENGTH).toBe(20)
		expect(isPasswordStrongEnough(ratePasswordStrength(twoClasses))).toBe(true)
		expect(isPasswordStrongEnough(ratePasswordStrength("a".repeat(PASSWORD_MIN_LENGTH)))).toBe(false)
		expect(isPasswordStrongEnough(ratePasswordStrength("a".repeat(PASSWORD_LONG_LENGTH)))).toBe(true)
	})
})
