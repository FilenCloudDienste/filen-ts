import { test, expect } from "@playwright/test"

// SDK-free: asserts the shell design system + typed i18n catalog render on the pre-auth sign-in
// surface under the hardened preview CSP, with no CSP violations reaching the console.
test.describe("shell", { tag: "@no-sdk" }, () => {
	test("the sign-in shell renders localized content with no CSP violations", async ({ page }) => {
		const consoleErrors: string[] = []
		const cspViolations: string[] = []

		page.on("console", msg => {
			if (msg.type() !== "error") {
				return
			}

			const text = msg.text()

			// arktype detects CSP by attempting `new Function` (@ark/util envHasCsp); under the app's
			// no-unsafe-eval CSP that probe is blocked — the browser logs a violation (firefox surfaces it
			// as a console error, chromium does not) and arktype falls back to interpreted validation. This
			// is arktype's intended CSP support, benign and expected, so it is not a shell failure.
			if (/unsafe-eval/i.test(text)) {
				return
			}

			consoleErrors.push(text)

			if (/content security policy|refused to/i.test(text)) {
				cspViolations.push(text)
			}
		})

		await page.goto("/")

		// Catalog strings resolve (no raw keys) across the sign-in card — the real login form (not the
		// pre-auth placeholder this test originally shipped against).
		await expect(page.getByText("Sign in to Filen")).toBeVisible()
		await expect(page.getByText("Your end-to-end encrypted drive, notes and chats.")).toBeVisible()
		await expect(page.getByText("Email", { exact: true })).toBeVisible()
		await expect(page.getByText("Password", { exact: true })).toBeVisible()
		await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
		await expect(page.getByRole("button", { name: "Forgot password?", exact: true })).toBeVisible()

		expect(cspViolations, cspViolations.join("\n")).toEqual([])
		expect(consoleErrors, consoleErrors.join("\n")).toEqual([])
	})
})
