import { fileURLToPath } from "node:url"
import { defineConfig, devices } from "@playwright/test"

// Playwright does not auto-load .env; load the local credentials file explicitly. Node >= 24 ships
// process.loadEnvFile, which throws when the file is missing — tolerated here because CI supplies the
// same variables (FILEN_WEB_E2E_TEST_EMAIL / FILEN_WEB_E2E_TEST_PASSWORD) directly from repository
// secrets, and contributors without credentials simply run the SDK-free subset.
try {
	process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url)))
} catch {
	// no local .env — credentials come from the environment (or the authed specs skip)
}

const PORT = 4173
const BASE_URL = `http://localhost:${String(PORT)}`

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: Boolean(process.env["CI"]),
	// The authed specs reuse a single injected session, so a retry never re-logs in (auth.setup itself
	// forces retries: 0). Retries only cover transient infra flakiness of the SDK-free specs on CI.
	retries: process.env["CI"] ? 1 : 0,
	reporter: [["html", { open: "never" }], ["list"]],
	timeout: 90_000,
	expect: { timeout: 15_000 },
	// The session blob is secret-equivalent; a trace would capture it as an addInitScript / evaluate
	// argument, so tracing stays off. Failure screenshots are an acceptable residual: the password
	// input always renders masked (screenshots capture pixels, not DOM values), and auth-setup /
	// auth.spec type only the dedicated e2e test account's email — never a customer's, never the
	// session blob.
	use: {
		baseURL: BASE_URL,
		trace: "off",
		screenshot: "only-on-failure"
	},
	projects: [
		{ name: "auth-setup", testMatch: /auth\.setup\.ts/ },
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
			dependencies: ["auth-setup"]
		},
		{
			// Verified empirically (login-free probe, real getDirectory()/SAH-pool open against this
			// exact Playwright build): Playwright's bundled Firefox has working OPFS-SAH storage, so it
			// boots the app like chromium and runs the full suite — unlike webkit below.
			name: "firefox",
			use: { ...devices["Desktop Firefox"] },
			dependencies: ["auth-setup"]
		},
		{
			// Playwright's bundled WebKit cannot open OPFS-SAH storage (verified empirically: it
			// exposes navigator.storage.getDirectory, but calling it rejects with a generic
			// UnknownError) — with OPFS now a hard boot requirement, EVERY route boots straight to
			// /no-opfs, so webkit can never reach the `@no-sdk` app specs (shell/keymap/register/reset)
			// that need a real boot-to-ready. Real Safari 16.4+ has OPFS and works fine; this is a
			// Playwright-WebKit limitation only, the same story as its lack of SharedArrayBuffer —
			// scoped down to the capability-gate pages themselves (no-coi + no-opfs), which render
			// independently of whether the app can boot at all, so it still needs no auth-setup
			// dependency and stays runnable without credentials.
			name: "webkit",
			use: { ...devices["Desktop Safari"] },
			grep: /@capability/
		}
	],
	webServer: {
		// Build with the e2e hooks, then serve dist with the full COI + hardened-CSP header set. Dev
		// mode is CSP-exempt, so e2e always runs against preview.
		command: "npm run build && npm run preview",
		url: BASE_URL,
		reuseExistingServer: !process.env["CI"],
		timeout: 300_000,
		env: {
			VITE_E2E: "1",
			NODE_OPTIONS: "--max-old-space-size=8192"
		}
	}
})
