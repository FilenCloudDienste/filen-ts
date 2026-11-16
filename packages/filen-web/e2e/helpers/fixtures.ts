import type { Locator, Page } from "@playwright/test"
import { expect, readFixtureManifest } from "../fixtures"
import { clickSidebarLink, descendInto, type ListingHandle, setTallListingViewport, waitForListingSettled } from "./listing"
import { FIXTURE_FILES, type FixtureScenario } from "../fixtures/registry"

// The shared, READ-ONLY fixture tree: one scenario directory per test that only ever LOOKS at its
// files, each holding the exact set that test expects. Built once per run by setup/fixtures.setup.ts
// and trashed once by setup/fixtures.teardown.ts, replacing what used to be a create + upload + trash
// per test. That matters far beyond speed: every one of those was a drive mutation, and the SDK
// serialises them all on ONE account-wide `drive-write` lease it then waits for UNBOUNDED and without
// error (see playwright.config.ts's own lane note), so a contended write hangs the test until the
// suite timeout kills it — which orphans the lease and hangs the next one too. Fewer writes is a
// RELIABILITY change, not a performance one.
//
// The scenarios come from the scenario modules (fixtures/scenarios.ts), registered in fixtures/registry.ts.
export { FIXTURE_FILES, FIXTURE_SCENARIOS, type FixtureFileName, type FixtureScenario } from "../fixtures/registry"

// The fixture ROOT's own listing, one hop from the drive root. Worth having on its own: it is the one
// listing in the account with a known, stable row set (one directory per scenario) that no write-lane
// test can churn underneath an assertion.
export async function enterFixtureRoot(page: Page): Promise<ListingHandle> {
	await setTallListingViewport(page)

	const { fixtureRoot } = readFixtureManifest()
	const { listbox } = await waitForListingSettled(page)

	await descendInto(page, listbox, fixtureRoot)

	return waitForListingSettled(page)
}

// Read-only counterpart to enterScratchDirectory (helpers/listing.ts): same contract — call it with
// the page sitting on the drive ROOT listing, get the scenario listing back — but every step is a
// READ. Two descents rather than one, since the tree is root -> fixtureRoot -> scenario; the fixture
// root exists so the whole run's tree is ONE row at the account root (one create, one trash) instead
// of a dozen, and so the teardown has a single thing to remove.
export async function enterFixtureDirectory(page: Page, scenario: FixtureScenario): Promise<ListingHandle> {
	// Re-resolves against whatever listing is mounted, so this descent runs against the fixture root's
	// listing rather than a stale handle on the account root's.
	const { listbox } = await enterFixtureRoot(page)

	await descendInto(page, listbox, scenario)

	return waitForListingSettled(page)
}

// A fixture row is present from the start, but the first read of a scenario listing after a cold boot
// can still be slow under suite load.
const FIXTURE_ROW_TIMEOUT_MS = 45_000

// One row locator per scenario file, in FIXTURE_FILES order. Mapped over a type parameter so a tuple
// maps to a tuple.
type LocatorsFor<T extends readonly unknown[]> = { [K in keyof T]: Locator }
type FixtureRows<S extends FixtureScenario> = LocatorsFor<(typeof FIXTURE_FILES)[S]>

// enterFixtureDirectory plus each scenario file's row, awaited visible. Callers boot first, so any setup
// that has to precede the descent stays theirs.
export async function openFixtureRows<S extends FixtureScenario>(
	page: Page,
	scenario: S
): Promise<{ listbox: Locator; rows: FixtureRows<S> }> {
	const { listbox } = await enterFixtureDirectory(page, scenario)
	const rows = FIXTURE_FILES[scenario].map(name => listbox.getByRole("option", { name }))

	for (const row of rows) {
		await expect(row).toBeVisible({ timeout: FIXTURE_ROW_TIMEOUT_MS })
	}

	return { listbox, rows: rows as FixtureRows<S> }
}

// From anywhere, into a fixture scenario directory.
export async function gotoFixture(page: Page, scenario: FixtureScenario): Promise<Locator> {
	await clickSidebarLink(page, "Cloud Drive", /\/drive$/)

	const { listbox } = await openFixtureRows(page, scenario)

	return listbox
}
