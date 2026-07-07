import type { Page, Route } from "@playwright/test"
import { test, expect } from "@playwright/test"

// SDK-free: register() itself is never called (a real call would create an account against the
// rate-limited API — out of budget for this suite; see auth.spec's login-budget comment). Every
// assertion here is client-side form state, plus the one sanctioned raw fetch (registerCheck)
// intercepted via page.route so the suite never depends on a live network response.
const REGISTER_CHECK_URL = "**/v3/registerCheck"
const REGISTER_CHECK_PATH = "/v3/registerCheck"

// Deterministic ratePasswordStrength tiers (@filen/utils): length >= 10 with all of
// upper/lower/special -> strong (10-15 chars) or best (16+ chars); length >= 10 with exactly two of
// the three -> normal; anything else -> weak. Picked once here so every test reads the same fixtures.
const WEAK_PASSWORD = "abcdefgh" // 8 chars, lowercase only
const NORMAL_PASSWORD = "Abcdefghij" // 10 chars, upper+lower, no special
const STRONG_PASSWORD = "Abcdef@ghi" // 10 chars, upper+lower+special
const BEST_PASSWORD = "Abcdef@ghijklmnop" // 17 chars, upper+lower+special

// Every test navigates through this helper: the registerCheck route must be installed BEFORE
// goto (the query fires on mount — refetchOnMount: "always" — so a route added afterwards would
// miss it and leak a real request to the live endpoint), and the returned promise only resolves
// once the app has actually made that request — proving the interception engaged rather than just
// asserting a banner state that also holds before the query ever settles.
async function gotoRegister(page: Page, fulfillRegisterCheck: (route: Route) => Promise<void> | void): Promise<void> {
	await page.route(REGISTER_CHECK_URL, fulfillRegisterCheck)
	const registerCheckRequest = page.waitForRequest(req => req.url().includes(REGISTER_CHECK_PATH))

	await page.goto("/register")
	await expect(page.getByText("Create your account")).toBeVisible()
	await registerCheckRequest
}

const NOT_ELIGIBLE = (route: Route): Promise<void> => route.fulfill({ json: { status: true, data: { ok: false } } })

test.describe("register", { tag: "@no-sdk" }, () => {
	test("submit stays disabled until email, matching passwords, and minimum strength are all satisfied", async ({ page }) => {
		await gotoRegister(page, NOT_ELIGIBLE)

		const submit = page.getByRole("button", { name: "Create account", exact: true })
		await expect(submit).toBeDisabled()

		await page.getByLabel("Email", { exact: true }).fill("not-an-email")
		await page.getByLabel("Password", { exact: true }).fill(STRONG_PASSWORD)
		await page.getByLabel("Confirm password", { exact: true }).fill(STRONG_PASSWORD)
		await expect(submit).toBeDisabled() // invalid email still blocks a strong, matching password

		await page.getByLabel("Email", { exact: true }).fill("e2e-register-form@example.com")
		await expect(submit).toBeEnabled() // every gate now satisfied — never clicked: no real register call

		await page.getByLabel("Confirm password", { exact: true }).fill(`${STRONG_PASSWORD}x`)
		await expect(submit).toBeDisabled() // mismatch blocks again

		await page.getByLabel("Confirm password", { exact: true }).fill(STRONG_PASSWORD)
		await expect(submit).toBeEnabled() // matching again re-enables

		await page.getByLabel("Password", { exact: true }).fill(WEAK_PASSWORD)
		await page.getByLabel("Confirm password", { exact: true }).fill(WEAK_PASSWORD)
		await expect(submit).toBeDisabled() // weak is the only strength tier that blocks submit
	})

	test("the strength meter renders the right tier and helper for each password", async ({ page }) => {
		await gotoRegister(page, NOT_ELIGIBLE)

		const passwordField = page.getByLabel("Password", { exact: true })

		await passwordField.fill(WEAK_PASSWORD)
		await expect(page.getByText("Weak", { exact: true })).toBeVisible()
		await expect(page.getByText("Choose a stronger password to continue")).toBeVisible()

		await passwordField.fill(NORMAL_PASSWORD)
		await expect(page.getByText("Fair", { exact: true })).toBeVisible()
		await expect(page.getByText("Choose a stronger password to continue")).toHaveCount(0)

		await passwordField.fill(STRONG_PASSWORD)
		await expect(page.getByText("Strong", { exact: true })).toBeVisible()

		await passwordField.fill(BEST_PASSWORD)
		await expect(page.getByText("Very strong", { exact: true })).toBeVisible()
	})

	test("shows the eligibility banner when registerCheck reports eligible", async ({ page }) => {
		await gotoRegister(page, route => route.fulfill({ json: { status: true, data: { ok: true } } }))

		await expect(page.getByText("You are eligible for 10 GiB of free storage!")).toBeVisible()
		await expect(page.getByRole("link", { name: "Learn more", exact: true })).toBeVisible()
	})

	test("shows nothing when registerCheck fails (collapsed failure, not a negative claim)", async ({ page }) => {
		await gotoRegister(page, route => route.abort())

		await expect(page.getByText("You are eligible for 10 GiB of free storage!")).toHaveCount(0)
		await expect(page.getByText("You are not eligible", { exact: false })).toHaveCount(0)
	})
})
