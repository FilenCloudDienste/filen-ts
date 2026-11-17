import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { trackForeignRequests } from "./helpers/requests"
import { EMAIL_REMOTE } from "./fixtures/text"
import { MSG_EMBEDDED_SUBJECT, MSG_EMBEDDED_TEXT, MSG_SUBJECT, outlookMessageBytes } from "./helpers/msgFixtures"

// An Outlook message (.msg) read in the text-family worker: its HTML in the script-less frame with its own picture and
// nothing remote, no source view, and its embedded message opened as a message of its own and back.

test("an Outlook message shows its HTML with nothing remote and opens its embedded message", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })
	const remote: string[] = []

	context.on("request", request => {
		if (request.url().startsWith(EMAIL_REMOTE)) remote.push(request.url())
	})

	await withScratchDirectory(page, "preview-msg", async ({ listbox, runId }) => {
		const name = `e2e-${runId}-status.msg`

		await uploadFiles(page, [{ name, mimeType: "application/vnd.ms-outlook", buffer: await outlookMessageBytes() }], listbox)
		await listbox.getByRole("option", { name }).dblclick()

		const dialog = page.getByRole("dialog")

		await expect(dialog.getByRole("heading", { name: MSG_SUBJECT })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(dialog.getByText("Anna Berg <anna@example.com>", { exact: true })).toBeVisible()
		await expect(dialog.getByText("1 remote resource was not loaded.", { exact: true })).toBeVisible()
		await expect(dialog.getByRole("button", { name: "Source", exact: true })).toHaveCount(0)

		const frame = page.frameLocator(`iframe[title="${MSG_SUBJECT}"]`)

		await expect(frame.getByText("All green")).toBeVisible()
		await expect(frame.locator('img[alt="chart"]')).toHaveAttribute("src", /^blob:/u)
		await expect(frame.locator('img[alt="pixel"]')).not.toHaveAttribute("src", /.+/u)

		// The inline picture is not listed; the embedded message is, as a message file.
		await expect(dialog.getByText("Attachments (1)", { exact: true })).toBeVisible()
		await expect(dialog.getByText(`${MSG_EMBEDDED_SUBJECT}.msg`, { exact: true })).toBeVisible()
		await dialog.getByRole("button", { name: "Open", exact: true }).click()
		await expect(dialog.getByRole("heading", { name: MSG_EMBEDDED_SUBJECT })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(dialog.getByText(MSG_EMBEDDED_TEXT, { exact: true })).toBeVisible()
		await dialog.getByRole("button", { name: "Back to the message", exact: true }).click()
		await expect(dialog.getByRole("heading", { name: MSG_SUBJECT })).toBeVisible()

		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)
	})

	expect(remote).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
	expect(cspViolations).toEqual([])
})
