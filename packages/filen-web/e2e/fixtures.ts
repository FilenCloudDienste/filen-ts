import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test as base, expect } from "@playwright/test"

// The session blob is secret-equivalent and lives ONLY here (gitignored, mode 0600) and in the
// sessionStorage seed — it is never typed into a page, so it cannot appear in screenshots or DOM
// snapshots.
export const AUTH_DIR = fileURLToPath(new URL(".auth", import.meta.url))
export const SESSION_FILE = fileURLToPath(new URL(".auth/session.json", import.meta.url))

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
