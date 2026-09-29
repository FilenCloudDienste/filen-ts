import { test, expect } from "./fixtures"
import { bootTo, enterScratchDirectory, trashScratchDirectory, uploadFiles, LIVE_WRITE_TIMEOUT_MS } from "./helpers/listing"
import { focusEditorSurface } from "./helpers/editor"
import { resolveEditorModKey, resolveModKey } from "./helpers/modkey"

// The file editor's shortcuts on a real CodeMirror: find and replace (bound inside the editor, so the
// drive listing's own mod+f search stays out of it), Escape closing the search panel without closing the
// file, the markdown formatting keys, the rendered/source toggle (locked while dirty) and mod+s. The
// editor keys go through CodeMirror, whose idea of "mod" can differ from the app's under Playwright's
// device emulation (helpers/modkey.ts), hence the two resolvers.
test.describe.configure({ mode: "default" })

test("the file editor's shortcuts: find, replace, markdown formatting, preview toggle and save", async ({ page }) => {
	const runId = crypto.randomUUID()
	const scratchName = `e2e-editor-keys-${runId}`
	const fileName = `e2e-editor-keys-${runId}.md`

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		await uploadFiles(page, [{ name: fileName, mimeType: "text/markdown", buffer: Buffer.from("plain words here", "utf8") }], listbox)

		const row = listbox.getByRole("option", { name: fileName })

		await row.dblclick()

		const dialog = page.getByRole("dialog")
		const appMod = await resolveModKey(page)
		const editorMod = await resolveEditorModKey(page)

		// Rendered first; the toggle shortcut opens the source.
		await expect(dialog.getByText("plain words here")).toBeVisible({ timeout: 30_000 })
		await page.keyboard.press(`${appMod}+Shift+V`)

		const content = dialog.locator(".cm-content")

		await expect(content).toBeVisible({ timeout: 30_000 })
		await focusEditorSurface(content)

		// Find opens the editor's own search, not the listing's; Escape closes it and leaves the file open.
		await page.keyboard.press(`${editorMod}+F`)

		const search = dialog.locator(".cm-search")

		await expect(search).toBeVisible()
		await expect(search.locator("input[name=search]")).toBeFocused()
		await page.keyboard.press("Escape")
		await expect(search).toHaveCount(0)
		await expect(dialog).toBeVisible()

		// Replace opens the same panel on its replace field.
		await focusEditorSurface(content)
		await page.keyboard.press(`${editorMod}+Alt+F`)
		await expect(search.locator("input[name=replace]")).toBeFocused()
		await page.keyboard.press("Escape")
		await expect(search).toHaveCount(0)

		// Bold around a double-clicked word; the buffer is dirty, which locks the preview toggle.
		await content.getByText("plain words here").dblclick({ position: { x: 60, y: 8 } })
		await page.keyboard.press(`${editorMod}+B`)
		await expect(content).toContainText("plain **words** here")
		await page.keyboard.press(`${appMod}+Shift+V`)
		await expect(content).toBeVisible()

		// A link around the whole line, with its url placeholder selected and typed over.
		await page.keyboard.press(`${editorMod}+A`)
		await page.keyboard.press(`${editorMod}+K`)
		await page.keyboard.type("https://filen.io")
		await expect(content).toContainText("[plain **words** here](https://filen.io)")

		// mod+s saves: the Save button goes, as there is nothing left to save.
		const saveButton = dialog.getByRole("button", { name: "Save", exact: true })

		await expect(saveButton).toBeVisible()
		await page.keyboard.press(`${appMod}+S`)
		await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

		// The saved version opens rendered, and the toggle, unlocked now, goes back to its source.
		await expect(dialog.getByRole("link", { name: "plain words here" })).toBeVisible({ timeout: 30_000 })
		await page.keyboard.press(`${appMod}+Shift+V`)
		await expect(content).toContainText("[plain **words** here](https://filen.io)")
	} finally {
		await page.keyboard.press("Escape").catch(() => undefined)
		await trashScratchDirectory(page, scratchName)
	}
})
