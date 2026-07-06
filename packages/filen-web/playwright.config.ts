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
	// The session blob and credentials are secret-equivalent; a trace would capture them as
	// addInitScript / evaluate arguments, so tracing stays off. Failure screenshots are safe — no
	// secret is ever rendered into the UI (the drive is an empty placeholder, the login email field
	// shows only a placeholder string).
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
			name: "firefox",
			use: { ...devices["Desktop Firefox"] },
			dependencies: ["auth-setup"]
		},
		{
			// webkit runs only the SDK-free subset (no login / injected session), so it needs no
			// auth-setup dependency and stays runnable without credentials.
			name: "webkit",
			use: { ...devices["Desktop Safari"] },
			grep: /@no-sdk/
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
