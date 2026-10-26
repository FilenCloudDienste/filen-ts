import { test, expect } from "./fixtures"
import { bootTo, enterScratchDirectory, trashScratchDirectory, uploadFiles, LIVE_WRITE_TIMEOUT_MS } from "./helpers/listing"
import { focusEditorSurface } from "./helpers/editor"
import { resolveEditorModKey, resolveModKey } from "./helpers/modkey"
import { preview } from "@/locales/en/preview"

// The file editor's shortcuts on a real CodeMirror: find and replace (bound inside the editor, so the
// drive listing's own mod+f search stays out of it) opening the command bar's find field in place of
// CodeMirror's panel, Escape closing it without closing the file, the markdown formatting keys, the
// rendered/source switch (locked while dirty) and mod+s. The
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

		// Find opens the command bar's find field, not the listing's search nor CodeMirror's panel; Escape
		// closes it and leaves the file open.
		await page.keyboard.press(`${editorMod}+F`)

		const findField = dialog.getByRole("searchbox", { name: preview.previewDocxFindPlaceholder })

		await expect(findField).toBeFocused()
		await expect(dialog.locator(".cm-search")).toHaveCount(0)
		await page.keyboard.press("Escape")
		await expect(findField).toHaveCount(0)
		await expect(dialog).toBeVisible()

		// Replace opens the same field with its replace field beside it.
		await focusEditorSurface(content)
		await page.keyboard.press(`${editorMod}+Alt+F`)
		await expect(dialog.getByRole("textbox", { name: preview.previewDocxReplacePlaceholder })).toBeVisible()
		await expect(findField).toBeFocused()
		await page.keyboard.press("Escape")
		await expect(findField).toHaveCount(0)

		// Bold around a double-clicked word; the buffer is dirty, which locks the preview toggle.
		const line = content.getByText("plain words here")
		// Where "words" is drawn, by the fonts this browser has.
		const words = await line.evaluate(element => {
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)

			for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
				const start = node.textContent?.indexOf("words") ?? -1

				if (start >= 0) {
					const range = document.createRange()

					range.setStart(node, start)
					range.setEnd(node, start + "words".length)

					const rect = range.getBoundingClientRect()
					const box = element.getBoundingClientRect()

					return { x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + rect.height / 2 }
				}
			}

			throw new Error('no "words" in the line')
		})

		await line.dblclick({ position: words })
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
