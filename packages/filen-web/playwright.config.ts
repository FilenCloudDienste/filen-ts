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
	// Bounded: at this suite's size, unbounded workers (one chromium + a full SDK wasm thread pool
	// each) saturate a dev host and the live rate-limited API — runs blow up ~5x slower with disjoint
	// spurious failure sets. Four is empirically fast AND stable.
	workers: 4,
	forbidOnly: Boolean(process.env["CI"]),
	// The authed specs reuse a single injected session, so a retry never re-logs in (auth.setup itself
	// forces retries: 0). Retries only cover transient infra flakiness of the SDK-free specs on CI.
	retries: process.env["CI"] ? 1 : 0,
	reporter: [["html", { open: "never" }], ["list"]],
	// One generous per-test budget for every environment (no CI/local split, no per-spec overrides):
	// the suite runs against a live account through a real wasm SDK, and the same test that takes 40s
	// on a warm dev machine has been observed timing out on slower CI runners. Five minutes is a
	// ceiling for diagnosing a hang, not a target — expect polls and toPass envelopes still bound the
	// individual waits inside a test.
	timeout: 300_000,
	expect: { timeout: 15_000 },
	// The session blob is secret-equivalent; a trace would capture it as an addInitScript / evaluate
	// argument, so tracing stays off. Failure screenshots are an acceptable residual: the password
	// input always renders masked (screenshots capture pixels, not DOM values), and auth-setup /
	// auth.spec type only the dedicated e2e test account's email — never a customer's, never the
	// session blob.
	use: {
		baseURL: BASE_URL,
		trace: "off",
		screenshot: "only-on-failure",
		// Bounded, not Playwright's unlimited default: an action whose target silently detaches
		// mid-interaction (a menu closed by a concurrent re-render) must FAIL with a diagnosable
		// actionability error, not absorb the whole test budget — a menu click once hung a 240s test
		// this way. Sized well below the per-test ceiling so a dead action fails fast enough to leave
		// a readable error, while still absorbing a slow runner's worst single-interaction stall
		// (slow STATE changes belong in expect polls / toPass envelopes, not action waits).
		actionTimeout: 60_000
	},
	projects: [
		{ name: "auth-setup", testMatch: /auth\.setup\.ts/ },
		// Self-cleaning sweep: trashes every root item matching a retired e2e scratch-name prefix before
		// any spec project starts (see setup/cleanup.setup.ts). Depends on auth-setup rather than
		// duplicating its login, and every spec project below depends on THIS instead of auth-setup
		// directly — Playwright resolves the chain, so auth-setup still always runs first.
		// Generous timeout above even the suite default: a debris-heavy root sweeps one item per round
		// (see cleanup.setup.ts), and a backlog run has genuinely needed several minutes on its own.
		{ name: "cleanup-setup", testMatch: /cleanup\.setup\.ts/, dependencies: ["auth-setup"], timeout: 600_000 },
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
			dependencies: ["cleanup-setup"]
		},
		{
			// Verified empirically (login-free probe, real getDirectory()/SAH-pool open against this
			// exact Playwright build): Playwright's bundled Firefox has working OPFS-SAH storage, so it
			// boots the app like chromium and runs the full suite — unlike webkit below.
			name: "firefox",
			use: { ...devices["Desktop Firefox"] },
			dependencies: ["cleanup-setup"]
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
		// The command builds the app from scratch when no server is reused (always on CI) — a slow
		// runner needs real headroom for typecheck + vite build + preview boot before the first test.
		timeout: 600_000,
		env: {
			VITE_E2E: "1",
			NODE_OPTIONS: "--max-old-space-size=8192"
		}
	}
})
