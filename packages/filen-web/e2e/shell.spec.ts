import { test, expect } from "./fixtures"
import { CSP_VIOLATION_PATTERN, trackConsoleErrors } from "./helpers/csp"
import { BOOT_SETTLE_TIMEOUT_MS, bootToSignIn } from "./helpers/listing"

// SDK-free: asserts the shell design system + typed i18n catalog render on the pre-auth sign-in
// surface under the hardened preview CSP, with no CSP violations reaching the console. The sign-in and
// 404 pages render only once the SDK has booted, so each test's first wait carries the boot budget.
test.describe("shell", { tag: "@no-sdk" }, () => {
	test.use({ injectSession: false })

	test("the sign-in shell renders localized content with no CSP violations", async ({ page }) => {
		const consoleErrors = trackConsoleErrors(page)

		await bootToSignIn(page)

		// Catalog strings resolve (no raw keys) across the sign-in card — the real login form (not the
		// pre-auth placeholder this test originally shipped against).
		await expect(page.getByText("Your end-to-end encrypted drive, notes and chats.")).toBeVisible()
		await expect(page.getByText("Email", { exact: true })).toBeVisible()
		await expect(page.getByText("Password", { exact: true })).toBeVisible()
		await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
		await expect(page.getByRole("button", { name: "Forgot password?", exact: true })).toBeVisible()

		const cspViolations = consoleErrors.filter(message => CSP_VIOLATION_PATTERN.test(message))

		expect(cspViolations, cspViolations.join("\n")).toEqual([])
		expect(consoleErrors, consoleErrors.join("\n")).toEqual([])
	})

	test("the route's own title beats index.html's static one", async ({ page }) => {
		// The browser is the only real proof that React's hoisted <title> is inserted AHEAD of the static
		// fallback in index.html — a unit test cannot make that claim.
		await bootToSignIn(page)
		await expect(page).toHaveTitle("Sign in · Filen")
	})

	test("serves a robots.txt that keeps crawlers off the public-link prefixes", async ({ page }) => {
		const response = await page.request.get("/robots.txt")

		expect(response.status()).toBe(200)

		const body = await response.text()

		expect(body).toContain("Disallow: /f/")
		expect(body).toContain("Disallow: /d/")
	})

	test("carries the static description meta", async ({ page }) => {
		await page.goto("/")

		await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /end-to-end encrypted/)
	})

	test("an unknown root URL renders the 404 page", async ({ page }) => {
		await page.goto("/definitely-not-a-route")

		await expect(page.getByText("Page not found")).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
		await expect(page.getByRole("link", { name: "Go to Filen" })).toBeVisible()
		await expect(page).toHaveTitle("Page not found · Filen")
	})

	test("an unknown NESTED URL renders the 404 page under its own title, not its ancestor's", async ({ page }) => {
		// The regression test: /login/bogus fuzzy-matches /login, whose head still runs, so without
		// routeHead's not-found guard the tab would read "Sign in · Filen" while the 404 body renders.
		// /login is chosen because it is a nested not-found URL reachable without a session.
		await page.goto("/login/bogus")

		await expect(page.getByText("Page not found")).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
		await expect(page.getByRole("link", { name: "Go to Filen" })).toBeVisible()
		await expect(page).toHaveTitle("Page not found · Filen")
	})

	test("reduced motion collapses app animation but never the loading indicators", async ({ page }) => {
		// A CSS media query has no unit-test surface. Durations are compared NUMERICALLY: the CSSOM
		// canonicalizes computed <time> to seconds, so the 0.01ms rule reads back as "0.00001s" and a
		// string equality against "0.01ms" could never match.
		await page.emulateMedia({ reducedMotion: "reduce" })
		await page.goto("/")

		const submit = page.getByRole("button", { name: "Sign in", exact: true })

		await expect(submit).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })

		// Polled, not read once: the stylesheet the reduce rule lives in is applied on first paint, and a
		// computed read taken before it lands returns the un-reduced default. transition-all's un-reduced
		// Tailwind default is 150ms, so 0.00001 passes and 0.15 fails.
		await expect.poll(() => submit.evaluate(el => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThan(0.001)

		// No spinner renders pre-auth, and the CSS RULE is what is under test — so probe it
		// directly, alongside a no-data-slot control. Without the control the test cannot tell "the
		// exemption works" from "the media block never applied at all". Both probes are removed again.
		const durations = await page.evaluate(() => {
			const exempt = document.createElement("div")
			exempt.setAttribute("data-slot", "spinner")
			exempt.className = "animate-spin"

			const control = document.createElement("div")
			control.className = "animate-spin"

			document.body.append(exempt, control)

			const read = [getComputedStyle(exempt).animationDuration, getComputedStyle(control).animationDuration]

			exempt.remove()
			control.remove()

			return read
		})

		// animate-spin is a 1s animation: ~1 when exempt, 0.00001s when the reduce rule applies.
		expect(parseFloat(durations[0] ?? "")).toBeGreaterThan(0.5)
		expect(parseFloat(durations[1] ?? "")).toBeLessThan(0.001)

		await page.emulateMedia({ reducedMotion: null })
	})
})
