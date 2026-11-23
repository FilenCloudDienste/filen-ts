import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, gotoFixture } from "./helpers/fixtures"
import { trackCspViolations } from "./helpers/csp"
import { trackForeignRequests } from "./helpers/requests"
import { itemRow, openRowMenu } from "./helpers/archive"
import { menuItemName } from "./helpers/menu"
import {
	LEGACY_CYRILLIC_AS_KOI8_PREFIX,
	LEGACY_CYRILLIC_TEXT,
	MATH_REMOTE_IMAGES,
	EMAIL_ATTACHMENT_TEXT,
	EMAIL_REMOTE,
	EMAIL_SUBJECT,
	NOTEBOOK_STREAM_TEXT,
	MAILBOX_SUBJECTS,
	ISO_VOLUME,
	TORRENT_INFOHASH,
	TORRENT_TRACKER,
	TORRENT_WEB_SEED,
	MERMAID_DRAWN,
	MERMAID_REFUSED,
	MERMAID_REMOTE
} from "./fixtures/text"

// Reading text-family files, from the shared fixture tree only: a legacy codepage named by the encoding detector (its
// wasm loaded for real, under the page's isolation headers and CSP) and read again with another one; and markdown
// math painted as MathML while the file's remote images are never fetched; a torrent, subtitles, a calendar and contacts
// read in the text-family worker, nothing they name ever contacted; executables and a disc image shown by their
// headers.

const [CYRILLIC] = FIXTURE_FILES["preview-text-legacy"]
const [FORMULAS] = FIXTURE_FILES["preview-markdown-math"]
const [TORRENT] = FIXTURE_FILES["preview-torrent"]
const [CUES, MICRODVD, VOBSUB] = FIXTURE_FILES["preview-subtitles"]
const [CALENDAR, CONTACTS, VARIANTS] = FIXTURE_FILES["preview-pim"]
const [TOOL, SETUP, DISC] = FIXTURE_FILES["preview-binary-info"]
const [MESSAGE] = FIXTURE_FILES["preview-email"]
const [NOTEBOOK] = FIXTURE_FILES["preview-notebook"]
const [DIAGRAMS, FLOW] = FIXTURE_FILES["preview-mermaid"]
const [MAILBOX] = FIXTURE_FILES["preview-mailbox"]
const NEVER_RUN = "Never run. Read from the file's headers only."
const NO_PREVIEW = "Preview isn't available for this file type yet."

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
	const live = dialog.locator(".cm-editor.cm-lp")

	// The fixture is the user's own, so it opens in live preview: the formulas painted in place, the images named.
	await expect(live).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(live.locator("span[role=math]")).toHaveCount(2)
	await expect(live.getByText("[image: chart] (not loaded)", { exact: true })).toBeVisible()
	await expect(live.locator("img")).toHaveCount(0)

	// Read: the rendered page.
	await dialog.getByRole("button", { name: "Read", exact: true }).click()
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

test("subtitles open on their cues with the source a toggle away, and a VobSub .sub is read and not shown", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })

	await bootTo(page)

	const listbox = await gotoFixture(page, "preview-subtitles")
	const dialog = page.getByRole("dialog")

	await itemRow(listbox, CUES).dblclick()
	await expect(dialog.getByText("SRT · 2 cues · UTF-8 · 00:00:05", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText("Hello there.", { exact: true })).toBeVisible()
	await expect(dialog.getByRole("table", { name: "Cues" })).toHaveAttribute("aria-rowcount", "3")

	await dialog.getByRole("searchbox", { name: "Find in cues" }).fill("kenobi")
	await expect(dialog.getByRole("table", { name: "Cues" })).toHaveAttribute("aria-rowcount", "2")

	await dialog.getByRole("button", { name: "Source", exact: true }).click()
	await expect(dialog.locator(".cm-line").first()).toHaveText("1")
	await close(page)

	// MicroDVD: frames at 23.976 per second, a "|" a line break.
	await itemRow(listbox, MICRODVD).dblclick()
	await expect(dialog.getByText(/^SUB · 2 cues/u)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await close(page)

	// VobSub images: its first bytes are an MPEG pack header, which nothing previews.
	await itemRow(listbox, VOBSUB).dblclick()
	await expect(page.getByText(NO_PREVIEW, { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await close(page)

	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
	expect(cspViolations).toEqual([])
})

test("a calendar opens as an agenda and contacts as cards, nothing they name is fetched, and a genomics .vcf opens as text", async ({
	page,
	context
}) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })

	await bootTo(page)

	const listbox = await gotoFixture(page, "preview-pim")
	const dialog = page.getByRole("dialog")

	await itemRow(listbox, CALENDAR).dblclick()
	await expect(dialog.getByText(/E2E Team/u)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText(/2 entries/u)).toBeVisible()
	await expect(dialog.getByText("Every 2 weeks on Monday and Wednesday, 10 times", { exact: true })).toBeVisible()

	const planning = dialog.getByRole("button", { name: /Planning/u })

	await planning.click()
	await expect(planning).toHaveAttribute("aria-expanded", "true")
	await expect(dialog.getByText("https://calendar.e2e-never-contacted.example/planning", { exact: true })).toBeVisible()
	await expect(dialog.getByText("File taxes", { exact: true })).toBeVisible()
	await close(page)

	await itemRow(listbox, CONTACTS).dblclick()
	await expect(dialog.getByRole("listbox", { name: "2 contacts" })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText("+44 7700 900123", { exact: true })).toBeVisible()
	await expect(dialog.getByRole("button", { name: "Copy Phone (cell)" })).toBeVisible()
	await dialog.getByRole("option", { name: /Charles Babbage/u }).click()
	await expect(dialog.getByText("Difference engine", { exact: true })).toBeVisible()
	await close(page)

	// The same extension, a Variant Call Format file: its first line is no vCard's, so it opens as text.
	await itemRow(listbox, VARIANTS).dblclick()
	await expect(dialog.locator(".cm-line").first()).toHaveText("##fileformat=VCFv4.2", { timeout: LAZY_VIEWER_TIMEOUT_MS })
	await close(page)

	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
	expect(cspViolations).toEqual([])
})

test("executables and a disc image show what their headers say, and an extensionless program opened as text does too", async ({
	page,
	context
}) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })

	await bootTo(page)

	const listbox = await gotoFixture(page, "preview-binary-info")
	const dialog = page.getByRole("dialog")

	await itemRow(listbox, SETUP).dblclick()
	await expect(dialog.getByText("Windows executable (PE32+, x86-64)", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText("Windows console", { exact: true })).toBeVisible()
	await expect(dialog.getByText(NEVER_RUN, { exact: true })).toBeVisible()
	await close(page)

	await itemRow(listbox, DISC).dblclick()
	await expect(dialog.getByText("Disc image (ISO 9660)", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText(ISO_VOLUME, { exact: true })).toBeVisible()
	await close(page)

	// No extension: Open as text finds an ELF head and shows its card instead of the not-text notice.
	await openRowMenu(page, listbox, TOOL)
	await page.getByRole("menuitem", { name: menuItemName("Open as text") }).click()
	await expect(dialog.getByText("ELF executable (64-bit, x86-64)", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText("This file isn't text.", { exact: true })).toHaveCount(0)
	await close(page)

	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
	expect(cspViolations).toEqual([])
})

test("a message shows its own picture and attachment, and nothing remote it names is ever loaded", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })
	const remote: string[] = []

	context.on("request", request => {
		if (request.url().startsWith(EMAIL_REMOTE)) remote.push(request.url())
	})

	await bootTo(page)

	const listbox = await gotoFixture(page, "preview-email")
	const dialog = page.getByRole("dialog")

	await itemRow(listbox, MESSAGE).dblclick()
	await expect(dialog.getByRole("heading", { name: EMAIL_SUBJECT })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByText("Anna Berg <anna@example.com>", { exact: true })).toBeVisible()
	// The remote picture and the stylesheet's background, both refused and counted.
	await expect(dialog.getByText("2 remote resources were not loaded.", { exact: true })).toBeVisible()

	// The body in its script-less frame: the message's own picture resolved, the remote one gone.
	const frame = page.frameLocator(`iframe[title="${EMAIL_SUBJECT}"]`)

	await expect(frame.getByText("the report")).toBeVisible()
	await expect(frame.locator('img[alt="chart"]')).toHaveAttribute("src", /^blob:/u)
	await expect(frame.locator('img[alt="pixel"]')).toHaveCount(1)
	await expect(frame.locator('img[alt="pixel"]')).not.toHaveAttribute("src", /.+/u)

	await expect(dialog.getByText("Attachments (1)", { exact: true })).toBeVisible()
	await dialog.getByRole("button", { name: "Open", exact: true }).click()
	await expect(dialog.getByText(EMAIL_ATTACHMENT_TEXT, { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await dialog.getByRole("button", { name: "Back to the message", exact: true }).click()

	await dialog.getByRole("button", { name: "Source", exact: true }).click()
	await expect(dialog.locator(".cm-content")).toHaveAttribute("contenteditable", "false")
	await close(page)

	expect(remote).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
	expect(cspViolations).toEqual([])
})

test("Mermaid diagrams draw in their frame and nothing they name is ever fetched; a .mmd file opens on its diagram", async ({
	page,
	context
}) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })
	const remoteRequests: string[] = []

	context.on("request", request => {
		if ((MERMAID_REMOTE as readonly string[]).includes(request.url())) {
			remoteRequests.push(request.url())
		}
	})

	await bootTo(page)

	const listbox = await gotoFixture(page, "preview-mermaid")
	const dialog = page.getByRole("dialog")

	await itemRow(listbox, DIAGRAMS).dblclick()

	// The fixture is the user's own, so it opens in live preview, its diagrams judged as Read judges them (the first one
	// refused) and drawn in the same frame.
	const live = dialog.locator(".cm-editor.cm-lp")

	await expect(live).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(live.getByText("This diagram uses images or links, which previews don't load.").first()).toBeVisible({
		timeout: LAZY_VIEWER_TIMEOUT_MS
	})

	await dialog.getByRole("button", { name: "Read", exact: true }).click()
	await expect(dialog.getByRole("heading", { name: "Diagrams", level: 1 })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	const surface = page.getByRole("document", { name: DIAGRAMS })

	// The frame's first start parses mermaid: drawn within the viewer budget.
	await expect(surface.getByRole("img", { name: "Mermaid diagram" })).toHaveCount(MERMAID_DRAWN, { timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(surface.getByText("This diagram uses images or links, which previews don't load.")).toHaveCount(MERMAID_REFUSED)
	// Each drawing is a picture of the frame's SVG (a data: URL), never markup in the page.
	expect(
		await surface
			.getByRole("img", { name: "Mermaid diagram" })
			.evaluateAll(images => images.map(image => image.getAttribute("src")?.slice(0, 5)))
	).toEqual(Array.from({ length: MERMAID_DRAWN }, () => "data:"))
	await expect(surface.locator("svg foreignObject")).toHaveCount(0)

	await surface.getByRole("button", { name: "Show source" }).first().click()
	await expect(surface.getByText(MERMAID_REMOTE[0], { exact: false })).toBeVisible()

	// The frame: sandboxed with scripts only.
	await expect(page.locator('iframe[sandbox="allow-scripts"]')).toHaveCount(1)
	await close(page)
	// Closing the viewer removes its frame.
	await expect(page.locator('iframe[sandbox="allow-scripts"]')).toHaveCount(0)

	await itemRow(listbox, FLOW).dblclick()
	await expect(dialog.getByRole("img", { name: "Mermaid diagram" })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await dialog.getByRole("button", { name: "Source", exact: true }).click()
	await expect(dialog.locator(".cm-line").first()).toHaveText("flowchart LR")
	await close(page)

	expect(remoteRequests).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
	expect(cspViolations).toEqual([])
})

test("a notebook shows its cells, highlighted code and outputs, and loads nothing remote", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })
	const remote: string[] = []

	context.on("request", request => {
		if (request.url().startsWith(EMAIL_REMOTE)) remote.push(request.url())
	})

	await bootTo(page)

	const listbox = await gotoFixture(page, "preview-notebook")
	const dialog = page.getByRole("dialog")

	await itemRow(listbox, NOTEBOOK).dblclick()
	await expect(dialog.getByText("In [4]:", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByRole("heading", { name: "E2E notebook" })).toBeVisible()
	await expect(dialog.getByText(NOTEBOOK_STREAM_TEXT)).toBeVisible()
	// Highlighted as the editor would (near the viewport, on idle): the keyword is a span of its own.
	await expect(dialog.locator("pre code.fo-code-static span", { hasText: "def" })).toHaveCount(1)
	await expect(dialog.locator('img[src^="blob:"]')).toHaveCount(1)

	const frame = page.frameLocator('iframe[title="HTML output"]')

	await expect(frame.getByText("cell")).toBeVisible()
	await expect(frame.locator('img[alt="remote"]')).not.toHaveAttribute("src", /.+/u)

	await dialog.getByRole("button", { name: "Source", exact: true }).click()
	await expect(dialog.locator(".cm-content")).toContainText("nbformat")
	await close(page)

	expect(remote).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
	expect(cspViolations).toEqual([])
})

test("a mailbox lists its messages from its ranges and opens one in the email viewer", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })

	await bootTo(page)

	const listbox = await gotoFixture(page, "preview-mailbox")
	const dialog = page.getByRole("dialog")

	await itemRow(listbox, MAILBOX).dblclick()

	const list = dialog.getByRole("list", { name: "Messages" })

	await expect(dialog.getByText("3 messages", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(list.getByText(MAILBOX_SUBJECTS[1])).toBeVisible()

	// Filtered to its matches by sender or subject, and back.
	await dialog.getByRole("searchbox", { name: "Search senders and subjects" }).fill("third")
	// Shown on the visible line (hidden from assistive technology) and announced once by the live region.
	await expect(dialog.locator('[aria-hidden="true"]', { hasText: /^1 match$/ })).toBeVisible()
	await expect(dialog.getByRole("status").filter({ hasText: /^1 match$/ })).toHaveCount(1)
	await expect(list.getByText(MAILBOX_SUBJECTS[0])).toHaveCount(0)
	await dialog.getByRole("searchbox", { name: "Search senders and subjects" }).fill("")
	await expect(list.getByText(MAILBOX_SUBJECTS[0])).toBeVisible()

	await list.getByText(MAILBOX_SUBJECTS[1]).click()
	await expect(dialog.getByRole("heading", { name: MAILBOX_SUBJECTS[1] })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	// The quoted line is unquoted once.
	await expect(dialog.getByText("From a quoted line")).toBeVisible()
	await close(page)

	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
	expect(cspViolations).toEqual([])
})
