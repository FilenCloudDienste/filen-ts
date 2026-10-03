import type { Locator, Page } from "@playwright/test"
import { expect, readFixtureManifest } from "../fixtures"
import { descendInto, type ListingHandle, setTallListingViewport, waitForListingSettled } from "./listing"

// The shared, READ-ONLY fixture tree: one scenario directory per test that only ever LOOKS at its
// files, each holding the exact set that test expects. Built once per run by setup/fixtures.setup.ts
// and trashed once by setup/fixtures.teardown.ts, replacing what used to be a create + upload + trash
// per test. That matters far beyond speed: every one of those was a drive mutation, and the SDK
// serialises them all on ONE account-wide `drive-write` lease it then waits for UNBOUNDED and without
// error (see playwright.config.ts's own lane note), so a contended write hangs the test until the
// suite timeout kills it — which orphans the lease and hangs the next one too. Fewer writes is a
// RELIABILITY change, not a performance one.
//
// The file NAMES live here rather than in each spec because both sides need them: the setup uploads
// exactly this list, the spec locates exactly this list. Two copies that merely agree today would
// drift into a "row never appeared" timeout that names neither side. Names are plain and stable (no
// run id) — the containing scenario directory is already unique per run, so nothing collides.
//
// NO FILE NAME MAY BE A SUBSTRING OF A SIBLING: each spec locates its own rows with a bare
// `getByRole("option", { name })`, which matches accessible names by SUBSTRING, so a name that is a
// prefix of a sibling's turns the lookup for the shorter one into a strict-mode violation (observed
// live). The SCENARIO KEYS are no longer bound by it — every descent goes through descendInto, whose
// row lookup anchors the name on a token boundary (helpers/listing.ts).
//
// EXACT COUNTS ARE LOAD-BEARING. Several specs assert a listing's option count outright, and every
// preview pager leg depends on how many slots the overlay has (a two-file scenario is what makes
// "exactly one of Previous/Next is enabled from either end" true). Adding a file to a scenario
// "because it's convenient" breaks those tests; add a new scenario instead.
export const FIXTURE_FILES = {
	// Six rows for the rubber-band drags, asserted as toHaveCount(6). Zero-padded-free single digits
	// keep the nameAsc order identical to the index order the test selects by.
	marquee: ["marquee-0.txt", "marquee-1.txt", "marquee-2.txt", "marquee-3.txt", "marquee-4.txt", "marquee-5.txt"],
	// Exactly two slots: the overlay pager steps a -> b and back.
	"preview-image": ["preview-image-a.png", "preview-image-b.png"],
	"preview-heic": ["preview-heic.heic"],
	// Two independent PDFs opened in turn — the multi-page/text-layer one, then the annotation-link one.
	"preview-pdf-pages": ["preview-pdf.pdf", "preview-pdf-links.pdf"],
	"preview-pdf-locked": ["preview-pdf-locked.pdf"],
	// One shared base name so nameAsc puts the VIDEO at the middle pager index (mp3 < mp4 < png) —
	// preview-media.spec.ts's ArrowRight leg is only meaningful with Next actually enabled.
	"preview-media": ["preview-media.mp3", "preview-media.mp4", "preview-media.png"],
	"preview-docx": ["preview-docx.docx"],
	"preview-code": ["preview-code.ts"],
	// png + bmp + svg all thumbnail; txt must keep its file-type icon.
	thumbnails: ["thumbnails.png", "thumbnails.bmp", "thumbnails.txt", "thumbnails.svg"],
	"download-fsa": ["download-fsa.txt"],
	"download-zip": ["download-zip-a.txt", "download-zip-b.txt"],
	"download-sw": ["download-sw.txt"],
	"download-cancel": ["download-cancel.bin"],
	// The archive browser's read-only subjects (helpers/archiveFixtures.ts builds each). Name order is
	// the overlay pager's order, which the keyboard and entry-point legs step through. Every archive is
	// named "e2e-…": an extract of one may be trashed, and its directory takes the archive's base name.
	"archive-browse": [
		"e2e-arc-corrupt.tar.gz",
		"e2e-arc-empty.zip",
		"e2e-arc-garbage.zip",
		"e2e-arc-hostile.zip",
		"e2e-arc-links.tar",
		"e2e-arc-locked.zip",
		"e2e-arc-note.txt.gz",
		"e2e-arc-small.tar.gz",
		"e2e-arc-tree.zip"
	],
	// The gate pair: the big tarball lists only on "Browse contents", the zip after it at once.
	"archive-gate": ["e2e-arc-gate-big.tar.gz", "e2e-arc-gate-next.zip"],
	"archive-report": ["e2e-arc-many-links.zip"],
	"archive-huge": ["e2e-arc-100k.zip"],
	"archive-bulk": ["e2e-bulk-a.zip", "e2e-bulk-b.zip", "e2e-bulk-c.zip"],
	// Text files for the compress dialog's naming, and one zip for a mixed archive + file selection.
	"archive-dialogs": ["dialog-a.txt", "dialog-b.txt", "dialog-c.zip"]
} as const

export type FixtureScenario = keyof typeof FIXTURE_FILES
export type FixtureFileName = (typeof FIXTURE_FILES)[FixtureScenario][number]

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
