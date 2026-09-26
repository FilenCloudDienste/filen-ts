import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { test as setup, expect } from "@playwright/test"
import { AUTH_DIR, SESSION_FILE } from "../fixtures"
import { BOOT_SETTLE_TIMEOUT_MS, dismissStartupReminders } from "../helpers/listing"
import { waitForE2eHooks } from "../helpers/e2eHooks"

// Exactly one real login per run: this setup project runs once and every authed spec reuses the blob
// it writes (via the injection fixture) rather than logging in again — the production API rate-limits
// logins. retries: 0 guarantees a failed setup never turns into extra login attempts.
setup.describe.configure({ retries: 0 })

// The login's key derivation is CPU-bound and runs on a runner CPU several times slower than a laptop's.
const LOGIN_TIMEOUT_MS = 60_000

const email = process.env["FILEN_WEB_E2E_TEST_EMAIL"] ?? ""
const password = process.env["FILEN_WEB_E2E_TEST_PASSWORD"] ?? ""

setup("sign in through the real form and harvest the session", async ({ page }) => {
	setup.skip(email === "" || password === "", "no e2e credentials configured")

	await page.goto("/")
	// The login screen only renders once boot reaches "ready" (the SDK worker's thread pool must be up
	// before login can derive keys), so its presence gates the form fill below. Pinned at the cold-boot
	// budget rather than the expect default: the whole project graph depends on this one test and it
	// cannot retry, so a slow runner must not read as a broken login form.
	await expect(page.getByText("Sign in to Filen")).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
	await waitForE2eHooks(page)

	// Drive the REAL form for the one login the budget allows — genuine UI coverage of the field
	// wiring, submit gating, and the worker round-trip, not a bare evaluate() call. The password
	// input masks its value on screen regardless; the email is a dedicated e2e test account, never a
	// customer's. This account is plain (no two-factor) — a 2FA challenge here would time out below
	// rather than silently mis-mint, surfacing as a clear, single (retries: 0) failure.
	await page.getByLabel("Email", { exact: true }).fill(email)
	await page.getByLabel("Password", { exact: true }).fill(password)
	await page.getByRole("button", { name: "Sign in", exact: true }).click()

	// One budget covers the live login (key derivation on a slow CPU, the login round trip) and the authed
	// boot after it. It ends on whichever comes first: the authed nav, a startup reminder (which makes the
	// rest of the app inert until dismissed, hiding the nav), or a toast, which is how a rejected or
	// rate-limited login reports itself. A toast without the nav names the failure instead of timing out.
	const nav = page.getByRole("navigation", { name: "Filen" })
	const toasts = page.locator("[data-sonner-toast]")

	await expect(nav.or(toasts).or(page.getByRole("alertdialog")).first()).toBeVisible({ timeout: LOGIN_TIMEOUT_MS })

	if (!(await nav.isVisible()) && (await toasts.count()) > 0) {
		throw new Error(`Sign-in did not complete: ${JSON.stringify(await toasts.allInnerTexts())}`)
	}

	await dismissStartupReminders(page)
	await expect(nav).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })

	// Harvest the now-live worker session — NOT the kv copy: a persist failure (persisted: false, a
	// real documented outcome — see loginAttempt.ts) would leave nothing there even though the login
	// itself succeeded and the worker holds a perfectly good client.
	const session = await page.evaluate(() => window.__filenE2E.dumpSession())

	mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
	writeFileSync(SESSION_FILE, JSON.stringify({ session }), { mode: 0o600 })
	chmodSync(SESSION_FILE, 0o600)
})
