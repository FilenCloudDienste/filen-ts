import type { Page } from "@playwright/test"
import { readFixtureManifest } from "../fixtures"
import { descendInto, waitForListingSettled } from "./listing"

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
	// png + bmp both thumbnail; txt + svg must keep their file-type icon.
	thumbnails: ["thumbnails.png", "thumbnails.bmp", "thumbnails.txt", "thumbnails.svg"],
	"download-fsa": ["download-fsa.txt"],
	"download-zip": ["download-zip-a.txt", "download-zip-b.txt"],
	"download-sw": ["download-sw.txt"],
	"download-cancel": ["download-cancel.bin"]
} as const

export type FixtureScenario = keyof typeof FIXTURE_FILES
export type FixtureFileName = (typeof FIXTURE_FILES)[FixtureScenario][number]

// The fixture ROOT's own listing, one hop from the drive root. Worth having on its own: it is the one
// listing in the account with a known, stable row set (one directory per scenario) that no write-lane
// test can churn underneath an assertion.
//
// The tall viewport is the same virtualization workaround enterScratchDirectory documents: the
// listing renders rows through a virtualizer, so a row sorted below the fold may not be in the DOM at
// all, and a locator hunting one specific name would silently miss it.
export async function enterFixtureRoot(page: Page): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
	await page.setViewportSize({ width: 1280, height: 8000 })

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
export async function enterFixtureDirectory(
	page: Page,
	scenario: FixtureScenario
): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
	// Re-resolves against whatever listing is mounted, so this descent runs against the fixture root's
	// listing rather than a stale handle on the account root's.
	const { listbox } = await enterFixtureRoot(page)

	await descendInto(page, listbox, scenario)

	return waitForListingSettled(page)
}
