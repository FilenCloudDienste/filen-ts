import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test as base, expect } from "@playwright/test"

// The session blob is secret-equivalent and lives ONLY here (gitignored, mode 0600) and in the
// sessionStorage seed — it is never typed into a page, so it cannot appear in screenshots or DOM
// snapshots.
export const AUTH_DIR = fileURLToPath(new URL(".auth", import.meta.url))
export const SESSION_FILE = fileURLToPath(new URL(".auth/session.json", import.meta.url))

// Where setup/fixtures.setup.ts records the shared read-only fixture tree it built, for every spec
// worker (a separate process) and the teardown project to read back. Gitignored for the same reason
// as .auth/ above — it is per-run state, never source — though unlike the session blob it holds
// nothing secret: just a run id and a directory name.
export const FIXTURES_DIR = fileURLToPath(new URL(".fixtures", import.meta.url))
export const FIXTURES_FILE = fileURLToPath(new URL(".fixtures/tree.json", import.meta.url))

export interface FixtureManifest {
	runId: string
	// The fixture root's NAME, not its uuid: every navigation to it goes through the listing UI, which
	// locates rows by name — and a uuid'd deep link cannot be used at all here (the session-injection
	// init script re-navigates to "/" on every load, see thumbnails.spec.ts).
	fixtureRoot: string
}

// Throws rather than returning null: every caller is mid-test with nowhere useful to go without the
// tree, and the two ways this file can be missing (the fixtures-setup project did not run, or it ran
// in a different working copy) are both configuration mistakes that a "directory not found" timeout
// several steps later would disguise.
export function readFixtureManifest(): FixtureManifest {
	if (!existsSync(FIXTURES_FILE)) {
		throw new Error(`no fixture manifest at ${FIXTURES_FILE} — the fixtures-setup project has not run for this suite`)
	}

	return JSON.parse(readFileSync(FIXTURES_FILE, "utf8")) as FixtureManifest
}

// Must match src/e2e-hooks/index.ts and the app's SESSION_SLOT.
const SESSION_SLOT = "filen.e2e.session"

interface SessionFile {
	session: string
}

// Fixture every authed spec pulls in. It seeds the saved session blob into sessionStorage before the
// app loads on every navigation (page context — the worker-owned sqlite cannot be written from an
// init script; the app's own e2e hook moves it into the worker + kv and re-runs the route guards).
// Skips cleanly when no session was minted (no credentials), so the SDK-free subset still runs for
// contributors without credentials.
export const test = base.extend<{ injectedSession: string }>({
	injectedSession: async ({ page }, use) => {
		if (!existsSync(SESSION_FILE)) {
			test.skip(true, "no injected session (e2e credentials not configured)")

			return
		}

		const { session } = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as SessionFile

		await page.addInitScript(
			([slot, blob]) => {
				sessionStorage.setItem(slot, blob)
			},
			[SESSION_SLOT, session] as const
		)

		await use(session)
	}
})

export { expect }
