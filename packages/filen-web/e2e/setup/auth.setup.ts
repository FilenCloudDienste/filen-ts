import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { test as setup, expect } from "@playwright/test"
import { AUTH_DIR, SESSION_FILE } from "../fixtures"

// Exactly one real login per run: this setup project runs once and every authed spec reuses the blob
// it writes (via the injection fixture) rather than logging in again — the production API rate-limits
// logins. retries: 0 guarantees a failed setup never turns into extra login attempts.
setup.describe.configure({ retries: 0 })

const email = process.env["FILEN_WEB_E2E_TEST_EMAIL"] ?? ""
const password = process.env["FILEN_WEB_E2E_TEST_PASSWORD"] ?? ""

setup("mint a session", async ({ page }) => {
	setup.skip(email === "" || password === "", "no e2e credentials configured")

	await page.goto("/")
	// The login screen only renders once boot reaches "ready" (the SDK worker's thread pool must be up
	// before login can derive keys), so its presence gates the mint call. Credentials are never typed
	// into the page — they are passed to the app's own login hook.
	await expect(page.getByText("Sign in to Filen")).toBeVisible()
	await page.waitForFunction(() => "__filenE2E" in window)

	const session = await page.evaluate(([e, p]) => window.__filenE2E.mint(e, p), [email, password] as const)

	mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
	writeFileSync(SESSION_FILE, JSON.stringify({ session }), { mode: 0o600 })
	chmodSync(SESSION_FILE, 0o600)
})
