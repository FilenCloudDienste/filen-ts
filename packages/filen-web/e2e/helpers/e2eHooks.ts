import type { Page } from "@playwright/test"
import { expect } from "../fixtures"

// The app installs `window.__filenE2E` from a FIRE-AND-FORGET dynamic import (src/main.tsx: `void
// import("@/e2e-hooks")`), so the hooks arrive on their own schedule — a separate chunk fetched over
// the network, with nothing in the boot path awaiting it.
//
// That makes them a race, and a fatal one in exactly one situation: if the page goes offline (or the
// chunk request otherwise fails) while that import is still in flight, the fetch fails and the hooks
// are NEVER installed. Nothing retries the import, so no amount of waiting afterwards recovers — a test
// that then reaches for `window.__filenE2E` gets "Cannot read properties of undefined" forever.
//
// So this is a BARRIER, not a poll-until-lucky: call it before `setOffline(true)`, and after any reload
// whose next step touches the hooks. Online it resolves in milliseconds because the chunk is cached —
// the budget only has to hold a cold fetch on a loaded runner, where it is one more thing competing
// with the boot itself.
export async function waitForE2eHooks(page: Page): Promise<void> {
	await expect.poll(() => page.evaluate(() => "__filenE2E" in window), { timeout: 30_000 }).toBe(true)
}
