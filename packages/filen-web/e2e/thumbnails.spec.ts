import { test, expect } from "./fixtures"
import { bootTo, waitForListingSettled } from "./helpers/listing"
import { enterFixtureDirectory, FIXTURE_FILES } from "./helpers/fixtures"
import { trackCspViolations } from "./helpers/csp"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"
import { waitForE2eHooks } from "./helpers/e2eHooks"
import { waitForSwReady } from "./helpers/sw"

// The one live proof the whole thumbnail pipeline works end to end: a real SDK decode inside the sdk
// worker (range reads against the stored file, a webp encode in wasm, nothing ever downloaded into JS),
// a real OPFS write/read, and the icon-slot swap in both listing views — none of that is provable at
// the unit level (thumbnails.test.ts/thumbnails.logic.test.ts inject every collaborator). The bmp
// sibling matters because it is a NON-JPEG raster the browser used to own: `bmp` sits in the SDK's
// unconditional thumbnailable set (filen-sdk-rs/src/thumbnail.rs — no `#[cfg]` gate, unlike svg, which
// is native-only), so canMakeThumbnail is true and it must render a real thumbnail through the SDK just
// as the png does. It is the proof that the swap did not quietly narrow format coverage. It also boots
// a second, fresh document mid-test: the proof that the OPFS cache survives a real cold boot, not just
// a component remount.
test("png and bmp images render real thumbnails in both listing views, the text/svg siblings keep their icon, and a fresh reload repaints from the OPFS cache without regenerating", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	// The png/bmp pair that must thumbnail and the txt/svg pair that must not — provisioned once per run
	// by the fixtures-setup project, in that exact set (helpers/fixtures.ts).
	const [namePng, nameBmp, nameTxt, nameSvg] = FIXTURE_FILES.thumbnails

	const cspViolations = trackCspViolations(page)

	await bootTo(page)

	const { listbox } = await enterFixtureDirectory(page, "thumbnails")

	// The scenario directory's own url and uuid, off the URL the descent above just navigated to (mirrors
	// drive.spec.ts's own subdirectory-navigation assertion) — the uuid to probe its thumbnail's on-disk
	// cache entry by (parent, name) rather than by a uuid this test never otherwise sees, and the path to
	// boot straight back into below. The LAST segment, not the one right after /drive: the drive route's
	// splat carries the whole ancestor chain, and the fixture tree is two levels deep (root ->
	// fixtureRoot -> scenario).
	const scenarioPath = new URL(page.url()).pathname
	const fixtureUuid = /\/([^/]+)$/.exec(scenarioPath)?.[1]

	if (fixtureUuid === undefined) {
		throw new Error("fixture directory did not navigate to a uuid'd url")
	}

	const rowPng = listbox.getByRole("option", { name: namePng })
	const rowBmp = listbox.getByRole("option", { name: nameBmp })
	const rowTxt = listbox.getByRole("option", { name: nameTxt })
	const rowSvg = listbox.getByRole("option", { name: nameSvg })
	await expect(rowPng).toBeVisible({ timeout: 45_000 })
	await expect(rowBmp).toBeVisible({ timeout: 45_000 })
	await expect(rowTxt).toBeVisible({ timeout: 45_000 })
	await expect(rowSvg).toBeVisible({ timeout: 45_000 })

	// The PNG's icon slot swaps to a real <img> once the SDK's decode resolves — a generous timeout
	// covers the real range reads + wasm decode behind it. alt="" makes this element decorative (no
	// accessible "img" role), so it's found by tag, not role.
	const pngThumbList = rowPng.locator("img")
	await expect(pngThumbList).toBeVisible({ timeout: 30_000 })
	await expect(pngThumbList).toHaveAttribute("src", /^blob:/)

	// The bmp is a SECOND real thumbnail, not a negative: the SDK decodes it (unconditional entry in
	// THUMBNAILABLE_EXTENSIONS), so this row proves the SDK arm handles a non-JPEG raster and not just
	// the png's own format.
	const bmpThumbList = rowBmp.locator("img")
	await expect(bmpThumbList).toBeVisible({ timeout: 30_000 })
	await expect(bmpThumbList).toHaveAttribute("src", /^blob:/)

	// The other two siblings are never swapped to a thumbnail, each for its own reason, and each keeps
	// its file-type icon — itself an <img> of a static asset (not a blob: object URL like a real
	// thumbnail), so the proof is that the src stays a non-blob asset URL.
	//
	//   txt — no extension routes it to any thumbnail category and the SDK claims nothing for it.
	//   svg — refused outright regardless of the flag (sanitization posture; and the wasm build carries
	//         no SVG rasteriser either, so the flag agrees — this is defense in depth, not redundancy).
	await expect(rowTxt.locator("img")).toHaveCount(1)
	await expect(rowTxt.locator("img")).not.toHaveAttribute("src", /^blob:/)
	await expect(rowSvg.locator("img")).toHaveCount(1)
	await expect(rowSvg.locator("img")).not.toHaveAttribute("src", /^blob:/)

	// Grid view renders the identical thumbnail through a different slot (DriveTile, not DriveRow) —
	// the service's own uuid-keyed url cache makes this a render-path proof, not a second generation.
	await page.getByRole("button", { name: "Display", exact: true }).click()
	await page.getByRole("menuitemradio", { name: "Grid view", exact: true }).click()
	// Proven, not assumed: the option locator below matches a list ROW just as well as a tile, so a
	// radio click that never took would make this leg silently re-prove the list leg above it.
	await expect(page.getByRole("menuitemradio", { name: "Grid view", exact: true })).toHaveAttribute("aria-checked", "true")
	await page.keyboard.press("Escape")
	// The press is not the outcome: a menu still standing leaves the whole shell aria-hidden (Base UI's
	// markOthers), after which every getByRole below matches nothing and reports it as a missing tile.
	await expect(page.getByRole("menu")).toHaveCount(0)

	// Scoped to the listing, not the page: both view modes render the same single listbox
	// (directoryListing.tsx), so this stays the tile without reaching for a row anywhere else on screen.
	const tilePng = listbox.getByRole("option", { name: namePng })
	const pngThumbGrid = tilePng.locator("img")
	await expect(pngThumbGrid).toBeVisible({ timeout: 15_000 })
	await expect(pngThumbGrid).toHaveAttribute("src", /^blob:/)

	await page.getByRole("button", { name: "Display", exact: true }).click()
	await page.getByRole("menuitemradio", { name: "List view", exact: true }).click()
	await expect(page.getByRole("menuitemradio", { name: "List view", exact: true })).toHaveAttribute("aria-checked", "true")
	await page.keyboard.press("Escape")
	await expect(page.getByRole("menu")).toHaveCount(0)

	await waitForE2eHooks(page)

	const statBeforeReload = await page.evaluate(({ parentUuid, name }) => window.__filenE2E.thumbnailFileStat(parentUuid, name), {
		parentUuid: fixtureUuid,
		name: namePng
	})
	expect(statBeforeReload).not.toBeNull()

	// A fresh document, same session — proves the OPFS cache round-trips across a real cold boot, not
	// just a component remount within the same page. Straight to the scenario directory's own uuid'd
	// url, which a hard goto now lands and STAYS on: descending the tree by name a second time would
	// pay the whole two-hop preamble again to reach a listing this boot already renders, and the cold
	// boot is the only part of it this leg is about.
	await bootTo(page, scenarioPath)

	const { listbox: listboxAfterReload } = await waitForListingSettled(page)

	const rowPngAfterReload = listboxAfterReload.getByRole("option", { name: namePng })
	await expect(rowPngAfterReload).toBeVisible({ timeout: 15_000 })
	const pngThumbAfterReload = rowPngAfterReload.locator("img")
	await expect(pngThumbAfterReload).toBeVisible({ timeout: 30_000 })
	await expect(pngThumbAfterReload).toHaveAttribute("src", /^blob:/)

	await waitForE2eHooks(page)

	const statAfterReload = await page.evaluate(({ parentUuid, name }) => window.__filenE2E.thumbnailFileStat(parentUuid, name), {
		parentUuid: fixtureUuid,
		name: namePng
	})

	// Identical size AND lastModified proves the OPFS file was never rewritten between the two loads
	// — a real regeneration always truncates + rewrites (writeThumb), which would bump
	// lastModified; a pure cache-hit read never touches that path.
	expect(statAfterReload).toEqual(statBeforeReload)

	expect(cspViolations).toEqual([])
})

// The video half of the pipeline, which the SDK never touches: a frame is pulled client-side off the
// service worker's Range stream and encoded in the page. That makes it the one thumbnail path with a
// hard dependency on a CONTROLLING worker, and the only one with no fallback — mediaViewer drops to a
// buffered blob when streaming is unavailable, so video PLAYBACK can look healthy while every video
// thumbnail silently fails. Nothing covered it, which is how exactly that state shipped: the worker was
// registered only in production builds, so this path could not run in dev at all and the failure showed
// up as a missing image rather than an error. Asserting the rendered blob is what makes it visible.
test("a video row renders a real thumbnail off the service worker's stream", async ({ page, injectedSession, browserName }) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	const cspViolations = trackCspViolations(page)

	await bootTo(page)

	// This path has a HARD dependency on a controlling worker and no fallback, so the worker being ready
	// is a precondition, not something to race: without this the frame pull can start against an
	// unclaimed page and the row simply never gets an img, reported as a missing thumbnail.
	await waitForSwReady(page)

	const { listbox } = await enterFixtureDirectory(page, "preview-media")
	const [, nameMp4] = FIXTURE_FILES["preview-media"]
	const videoRow = listbox.getByRole("option", { name: nameMp4 })

	await expect(videoRow).toBeVisible({ timeout: 30_000 })

	// Generous because this is a real streamed decode, not a cache read: the worker serves Range
	// requests for the clip, the page seeks it and paints one frame. The blob: src is the load-bearing
	// half — an icon-only row also has no img, so presence alone would not distinguish "generated" from
	// "gave up", which is precisely the state that went unnoticed before.
	const videoThumb = videoRow.locator("img")

	await expect(videoThumb).toBeVisible({ timeout: 60_000 })
	await expect(videoThumb).toHaveAttribute("src", /^blob:/)

	expect(cspViolations, `CSP violations: ${JSON.stringify(cspViolations)}`).toHaveLength(0)
})
