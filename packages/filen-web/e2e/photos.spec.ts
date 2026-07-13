import { test, expect } from "./fixtures"
import { enterScratchDirectory, trashScratchDirectory } from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// The one live proof of the whole photos arc: root selection, the media-only grid over a mixed
// upload, the viewer wired to the shared preview overlay, a favorite toggled FROM INSIDE that overlay
// reflecting back into the grid without a reload (the one patch step3 actually adds — trash/rename
// already converge for free via the drive socket echo's photos-invalidation set), the change-directory
// affordance, and the root-gone reset once the chosen directory is trashed. Net-zero via the same
// scratch-directory convention as every other upload spec.

// A real 1x1 transparent PNG — duplicated from preview-media.spec.ts (no cross-spec e2e helpers module).
const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")

// A real, tiny synthetic H.264/mp4 clip (64x64, 2s @ 5fps) — generated once via
// `ffmpeg -f lavfi -i testsrc=size=64x64:rate=5:duration=2 -c:v libx264 -profile:v baseline
// -pix_fmt yuv420p -crf 30 -g 5 -movflags +faststart -an`. Real container/codec structure (unlike a
// hand-rolled byte string) so the predicate/thumbnail/overlay all treat it as a genuine video, not
// preview-media.spec.ts's own larger seek-proving fixture — this spec never seeks, so the smallest
// clip that still round-trips through the whole media pipeline is the right amount of fixture here.
const MP4_BYTES = Buffer.from(
	"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",
	"base64"
)

test("photos: root pick over a mixed upload, media-only grid, viewer pager + in-overlay favorite reflecting back without a reload, change-directory, and root-gone reset", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-photos-${runId}`
	const nameImage = `e2e-photos-${runId}.png`
	const nameVideo = `e2e-photos-${runId}.mp4`
	const nameDoc = `e2e-photos-${runId}.txt`

	await page.goto("/drive")

	try {
		const { listbox: driveListbox } = await enterScratchDirectory(page, scratchName)

		await page
			.locator('input[type="file"]')
			.first()
			.setInputFiles([
				{ name: nameImage, mimeType: "image/png", buffer: PNG_BYTES },
				{ name: nameVideo, mimeType: "video/mp4", buffer: MP4_BYTES },
				{ name: nameDoc, mimeType: "text/plain", buffer: Buffer.from("photos grid must never show this row") }
			])

		await expect(driveListbox.getByRole("option", { name: nameImage })).toBeVisible({ timeout: 45_000 })
		await expect(driveListbox.getByRole("option", { name: nameVideo })).toBeVisible({ timeout: 45_000 })
		await expect(driveListbox.getByRole("option", { name: nameDoc })).toBeVisible({ timeout: 45_000 })

		// ---- navigate to /photos: unset hero (no root picked yet) ----
		await page.getByRole("link", { name: "Photos", exact: true }).first().click()
		await page.waitForURL(/\/photos$/)
		await expect(page.getByText("Choose your photos directory")).toBeVisible()

		// ---- choose the scratch directory as the photos root ----
		await page.getByRole("button", { name: "Choose directory", exact: true }).click()
		const chooser = page.getByRole("dialog")
		await expect(chooser).toBeVisible()
		await chooser.getByRole("button", { name: scratchName, exact: true }).dblclick()
		const confirm = chooser.getByRole("button", { name: "Choose this directory", exact: true })
		await expect(confirm).toBeEnabled()
		await confirm.click()
		await expect(chooser).toHaveCount(0)

		// ---- grid shows exactly the 2 media tiles, txt excluded ----
		const grid = page.getByRole("listbox", { name: "Photos grid" })
		await expect(grid).toBeVisible({ timeout: 30_000 })
		const imageTile = grid.locator(`[title="${nameImage}"]`)
		const videoTile = grid.locator(`[title="${nameVideo}"]`)
		await expect(imageTile).toBeVisible({ timeout: 45_000 })
		await expect(videoTile).toBeVisible({ timeout: 45_000 })
		await expect(grid.getByRole("option")).toHaveCount(2)
		await expect(grid.locator(`[title="${nameDoc}"]`)).toHaveCount(0)

		// ---- click opens the overlay on the RIGHT item; the pager steps to the other one ----
		await imageTile.click()
		const overlay = page.getByRole("dialog")
		await expect(page.getByRole("img", { name: nameImage })).toBeVisible({ timeout: 30_000 })

		await overlay.getByRole("button", { name: "Next file", exact: true }).click()
		await expect(page.locator("video")).toBeVisible({ timeout: 30_000 })

		// ---- favorite FROM INSIDE the overlay (the currently-viewed video slot) ----
		const menuTrigger = overlay.getByRole("button", { name: "More actions", exact: true })
		const menu = page.getByRole("menu")
		await menuTrigger.click()
		await expect(menu).toBeVisible()
		await menu.getByRole("menuitem", { name: "Favorite", exact: true }).click()
		await expect(menu).toHaveCount(0)

		await page.keyboard.press("Escape")
		await expect(overlay).toHaveCount(0)

		// ---- the patch proof: the grid's heart badge shows on the video tile with NO reload ----
		await expect(videoTile.getByText("Favorited")).toBeVisible({ timeout: 20_000 })

		// ---- change-directory affordance re-opens the chooser ----
		await page.getByRole("button", { name: "Change directory", exact: true }).click()
		await expect(page.getByRole("dialog")).toBeVisible()
		await page.keyboard.press("Escape")
		await expect(page.getByRole("dialog")).toHaveCount(0)

		// ---- trash the scratch directory itself (root-gone), then revisit /photos ----
		await trashScratchDirectory(page, scratchName)

		await page.getByRole("link", { name: "Photos", exact: true }).first().click()
		await page.waitForURL(/\/photos$/)

		await expect(page.getByText("Your photos directory is no longer available.")).toBeVisible({ timeout: 20_000 })
		await expect(page.getByText("Choose your photos directory")).toBeVisible()
	} finally {
		// Idempotent-safe: a no-op once the directory above was already trashed (trashScratchDirectory's
		// own "row not found" branch returns early) — the net-zero safety net if an earlier assertion
		// threw before that point was reached.
		await trashScratchDirectory(page, scratchName)
	}
})
