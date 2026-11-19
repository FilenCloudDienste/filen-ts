// @vitest-environment jsdom

// The strength label is the only text naming the tier, so its colour must read on the card in both
// themes: a palette shade picked for one theme fails contrast on the other (yellow-500 is ~1.9:1 on the
// light card). Every palette-coloured tier therefore carries a light shade and a separate dark: shade;
// a theme token (destructive) already resolves per theme.
import { afterEach, describe, expect, it } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import type { PasswordStrength } from "@filen/shared"
import { StrengthMeter } from "@/features/auth/components/strengthMeter"

const PALETTE_TEXT = /^text-[a-z]+-\d{2,3}$/
const PALETTE_DARK_TEXT = /^dark:text-[a-z]+-\d{2,3}$/

afterEach(() => {
	cleanup()
})

function labelClasses(tier: PasswordStrength): string[] {
	const { container } = render(createElement(StrengthMeter, { tier }))
	const label = container.querySelector("p")

	if (!label) {
		throw new Error(`strength meter rendered no label for tier: ${tier}`)
	}

	return [...label.classList]
}

describe("StrengthMeter — label shade per theme", () => {
	it.each<PasswordStrength>(["normal", "strong", "best"])("gives the %s label a light and a dark shade", tier => {
		const classes = labelClasses(tier)

		expect(classes.filter(name => PALETTE_TEXT.test(name))).toHaveLength(1)
		expect(classes.filter(name => PALETTE_DARK_TEXT.test(name))).toHaveLength(1)
	})

	it("colours the weak label with the per-theme destructive token", () => {
		expect(labelClasses("weak")).toContain("text-destructive")
	})
})
