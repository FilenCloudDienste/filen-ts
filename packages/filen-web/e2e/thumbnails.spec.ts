import { test, expect } from "./fixtures"
import { enterFixtureDirectory, FIXTURE_FILES } from "./helpers/fixtures"
import { trackCspViolations } from "./helpers/csp"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"
import { waitForE2eHooks } from "./helpers/e2eHooks"

// The one live proof the whole thumbnail pipeline works end to end: a real SDK decode inside the sdk
// worker (range reads against the stored file, a webp encode in wasm, nothing ever downloaded into JS),
// a real OPFS write/read, and the icon-slot swap in both listing views — none of that is provable at
// the unit level (thumbnails.test.ts/thumbnails.logic.test.ts inject every collaborator). The bmp
// sibling matters because it is a NON-JPEG raster the browser used to own: `bmp` sits in the SDK's
// unconditional thumbnailable set (filen-sdk-rs/src/thumbnail.rs — no `#[cfg]` gate, unlike svg, which
// is native-only), so canMakeThumbnail is true and it must render a real thumbnail through the SDK just
// as the png does. It is the proof that the swap did not quietly narrow format coverage. Also the one
// deliberate reload in this suite (every other spec stays client-nav): proves the OPFS cache survives a
// real cold document boot, not just a component remount.
test("png and bmp images render real thumbnails in both listing views, the text/svg siblings keep their icon, and a fresh reload repaints from the OPFS cache without regenerating", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	// Explicit opt-in above the read lane's 360s: the reload leg below enters the shared fixture tree a
	// SECOND time, so this one test pays that 188s descent preamble twice before any wait of its own.
	test.setTimeout(600_000)

	// The png/bmp pair that must thumbnail and the txt/svg pair that must not — provisioned once per run
	// by the fixtures-setup project, in that exact set (helpers/fixtures.ts).
	const [namePng, nameBmp, nameTxt, nameSvg] = FIXTURE_FILES.thumbnails

	const cspViolations = trackCspViolations(page)

	await page.goto("/drive")

	const { listbox } = await enterFixtureDirectory(page, "thumbnails")

	// The scenario directory's own uuid, off the URL the descent above just navigated to (mirrors
	// drive.spec.ts's own subdirectory-navigation assertion) — needed below to probe its thumbnail's
	// on-disk cache entry by (parent, name) rather than by a uuid this test never otherwise sees. The
	// LAST segment, not the one right after /drive: the drive route's splat carries the whole ancestor
	// chain, and the fixture tree is two levels deep (root -> fixtureRoot -> scenario).
	const fixtureUuid = /\/([^/]+)$/.exec(page.url())?.[1]

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

	const tilePng = page.getByRole("option", { name: namePng })
	const pngThumbGrid = tilePng.locator("img")
	await expect(pngThumbGrid).toBeVisible({ timeout: 15_000 })
	await expect(pngThumbGrid).toHaveAttribute("src", /^blob:/)

	await page.getByRole("button", { name: "Display", exact: true }).click()
	await page.getByRole("menuitemradio", { name: "List view", exact: true }).click()
	await expect(page.getByRole("menuitemradio", { name: "List view", exact: true })).toHaveAttribute("aria-checked", "true")
	await page.keyboard.press("Escape")

	await waitForE2eHooks(page)

	const statBeforeReload = await page.evaluate(({ parentUuid, name }) => window.__filenE2E.thumbnailFileStat(parentUuid, name), {
		parentUuid: fixtureUuid,
		name: namePng
	})
	expect(statBeforeReload).not.toBeNull()

	// The one deliberate reload in this suite: a fresh document, same session — proves the OPFS
	// cache round-trips across a real cold boot, not just a component remount within the same page.
	// Reloads to /drive (root), never straight to the fixture directory's own uuid'd url: the
	// injected-session fixture's addInitScript reseeds sessionStorage on EVERY navigation, and the
	// app's own seedFromSlot unconditionally re-navigates to "/" once it replays that seed — which
	// index.tsx resolves to the bare drive root regardless of what url was actually requested, so a
	// direct goto to a nested path is silently overridden (reproduced live: it lands back at root,
	// not the deep link). Re-descending by name below still exercises a genuine cold document boot.
	await page.goto("/drive")
	const { listbox: listboxAfterReload } = await enterFixtureDirectory(page, "thumbnails")

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
