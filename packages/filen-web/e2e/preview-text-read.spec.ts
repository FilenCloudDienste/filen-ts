import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, gotoFixture } from "./helpers/fixtures"
import { trackCspViolations } from "./helpers/csp"
import { trackForeignRequests } from "./helpers/requests"
import {
	LEGACY_CYRILLIC_AS_KOI8_PREFIX,
	LEGACY_CYRILLIC_TEXT,
	MATH_REMOTE_IMAGES,
	TORRENT_INFOHASH,
	TORRENT_TRACKER,
	TORRENT_WEB_SEED
} from "./fixtures/text"

// Reading text-family files, from the shared fixture tree only: a legacy codepage named by the encoding detector (its
// wasm loaded for real, under the page's isolation headers and CSP) and read again with another one; and markdown
// math painted as MathML while the file's remote images are never fetched.

const [CYRILLIC] = FIXTURE_FILES["preview-text-legacy"]
const [FORMULAS] = FIXTURE_FILES["preview-markdown-math"]
const [TORRENT] = FIXTURE_FILES["preview-torrent"]

const MATHML = "http://www.w3.org/1998/Math/MathML"

async function close(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.getByRole("dialog")).toHaveCount(0)
}

test("a legacy text file reads with the detected codepage and reopens with another", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })

	await bootTo(page)

	const listbox = await gotoFixture(page, "preview-text-legacy")

	await listbox.getByRole("option", { name: CYRILLIC }).dblclick()

	const dialog = page.getByRole("dialog")
	const firstLine = LEGACY_CYRILLIC_TEXT.split("\n")[0] ?? ""

	// Not Unicode: the detector names windows-1251 before anything is shown.
	await expect(dialog.locator(".cm-line").first()).toHaveText(firstLine, { timeout: LAZY_VIEWER_TIMEOUT_MS })

	const encoding = dialog.getByRole("button", { name: "Encoding: Windows-1251" })

	await encoding.click()
	await expect(page.getByText("Detected: Windows-1251", { exact: true })).toBeVisible()

	await page.getByRole("menuitem", { name: "Reopen with encoding" }).click()
	await page.getByRole("menuitemradio", { name: "Cyrillic (KOI8-R)" }).click()

	await expect(dialog.locator(".cm-line").first()).toHaveText(new RegExp(`^${LEGACY_CYRILLIC_AS_KOI8_PREFIX}`, "u"))
	await expect(dialog.getByRole("button", { name: "Encoding: KOI8-R" })).toBeVisible()

	// Back to what was detected.
	await dialog.getByRole("button", { name: "Encoding: KOI8-R" }).click()
	await page.getByRole("menuitem", { name: "Reopen with encoding" }).click()
	await page.getByRole("menuitemradio", { name: "Cyrillic (Windows-1251)" }).click()
	await expect(dialog.locator(".cm-line").first()).toHaveText(firstLine)

	await close(page)

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
})

test("markdown math renders as MathML and its remote images are never fetched", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })
	const imageRequests: string[] = []

	context.on("request", request => {
		if ((MATH_REMOTE_IMAGES as readonly string[]).includes(request.url())) {
			imageRequests.push(request.url())
		}
	})

	await bootTo(page)

	const listbox = await gotoFixture(page, "preview-markdown-math")

	await listbox.getByRole("option", { name: FORMULAS }).dblclick()

	const dialog = page.getByRole("dialog")

	await expect(dialog.getByRole("heading", { name: "Formulas", level: 1 })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	// Inline and display formulas, each a MathML tree; prices stay text.
	const formulas = dialog.locator("span[role=math]")

	await expect(formulas).toHaveCount(2)
	await expect(formulas.first()).toHaveAttribute("aria-label", "e^{i\\pi} + 1 = 0")
	expect(await formulas.evaluateAll(hosts => hosts.map(host => host.firstElementChild?.namespaceURI))).toEqual([MATHML, MATHML])
	await expect(dialog.getByText("It costs $5 and $10 today.", { exact: true })).toBeVisible()

	// Named in place, never loaded.
	await expect(dialog.getByText("[image: chart] (not loaded)", { exact: true })).toBeVisible()
	await expect(dialog.getByText("[image: photo] (not loaded)", { exact: true })).toBeVisible()
	await expect(page.getByRole("document", { name: FORMULAS }).locator("img")).toHaveCount(0)

	await close(page)

	expect(imageRequests).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
	expect(cspViolations).toEqual([])
})

test("a torrent shows its infohash, tracker, web seed and files, and neither address is ever contacted", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })

	await bootTo(page)

	const listbox = await gotoFixture(page, "preview-torrent")

	await listbox.getByRole("option", { name: TORRENT }).dblclick()

	const dialog = page.getByRole("dialog")

	await expect(dialog.getByText("E2E Album", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText(TORRENT_INFOHASH, { exact: true })).toBeVisible()
	await expect(dialog.getByText(TORRENT_TRACKER, { exact: true })).toBeVisible()
	await expect(dialog.getByText(TORRENT_WEB_SEED, { exact: true })).toBeVisible()
	await expect(dialog.getByText("E2E Album/01 Intro.flac", { exact: true })).toBeVisible()

	await close(page)

	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
	expect(cspViolations).toEqual([])
})
