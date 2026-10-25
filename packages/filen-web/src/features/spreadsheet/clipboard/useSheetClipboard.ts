import { useEffect, useRef, type RefObject } from "react"
import { MAX_HTML_COPY_CELLS } from "@filen/office/core/sheet"
import { isMacPlatform, type SheetGridModel } from "@filen/office/react/sheet"
import type { TFunction } from "i18next"
import { toast } from "sonner"
import { useLatestRef } from "@/lib/useLatestRef"
import { MAX_PASTE_HTML, sanitizeSheetClipboard } from "@/features/spreadsheet/clipboard/sheetClipboardSanitizer"

// Copy, cut and paste while the grid has focus, as tab-separated text and HTML (a table with values, formulas and
// formats, which Excel, Google Sheets and LibreOffice read). Listened for on the document: Firefox sends clipboard
// events to the body when the focused element holds no text selection, as the grid never does. The session holds the
// cells, so a copy's text and HTML arrive after the event: they go to the clipboard as pending items. A paste of the
// session's own latest copy names it, so formulas move and formats come along (a cut moves its cells); other HTML is
// sanitised and read by the session, else the text is pasted. The same commands are handed back for controls (the
// touch menu), which write and read the clipboard through its API inside their press.

export type SheetClipboardResult = "done" | "tooLarge" | "blocked"

// What a control's copy, cut or paste says when it did not go through: the browser blocked the clipboard (the shortcut
// `key` still works) or the copy was too large.
export function sayClipboardRefusal(result: SheetClipboardResult, key: string, t: TFunction<"preview">): void {
	if (result === "blocked") {
		toast.error(t("previewSheetClipboardBlocked", { shortcut: isMacPlatform() ? `⌘${key}` : `Ctrl+${key}` }))
	} else if (result === "tooLarge") {
		toast.error(t("previewSpreadsheetCopyTooLarge"))
	}
}

export interface SheetClipboardCommands {
	copy(cut: boolean): Promise<SheetClipboardResult>
	// Values only: the clipboard's text read as tab-separated values, never its formats or formulas (the ribbon's
	// Paste values).
	paste(values: boolean): Promise<SheetClipboardResult>
}

// HTML and text where the browser lets the page read both, else text alone; null when it refused.
async function readClipboard(): Promise<{ text: string; html: string } | null> {
	try {
		const out = { text: "", html: "" }

		for (const item of await navigator.clipboard.read()) {
			if (out.html === "" && item.types.includes("text/html")) {
				out.html = await (await item.getType("text/html")).text()
			}

			if (out.text === "" && item.types.includes("text/plain")) {
				out.text = await (await item.getType("text/plain")).text()
			}
		}

		return out
	} catch {
		try {
			return { text: await navigator.clipboard.readText(), html: "" }
		} catch {
			return null
		}
	}
}
export function useSheetClipboard({
	model,
	container,
	canEdit,
	onRefused
}: {
	model: SheetGridModel
	container: RefObject<HTMLElement | null>
	canEdit: boolean
	// A copy too large, or a clipboard the browser would not write.
	onRefused: (reason: "tooLarge" | "failed") => void
}): SheetClipboardCommands {
	const latest = useLatestRef({ model, canEdit, onRefused })
	// The session's latest copy (or cut): a paste of it names it.
	const lastClip = useRef<number | null>(null)

	function copy(cut: boolean): Promise<SheetClipboardResult> {
		const { model: grid } = latest.current
		const { sheet, selection } = grid.getSnapshot()
		const range = selection.ranges[selection.ranges.length - 1]

		// A chartsheet has no cells to copy.
		if (range === undefined || (cut && !latest.current.canEdit) || grid.cellless()) {
			return Promise.resolve("done")
		}

		const text = grid.session.query("copy", { sheet, range, cut }).then(answer => {
			if ("refused" in answer) {
				throw new RangeError("tooLarge")
			}

			lastClip.current = answer.clip

			return answer.text
		})
		const cells = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1)
		// Decided now, inside the gesture: an item the clipboard is promised must arrive.
		const html =
			cells <= MAX_HTML_COPY_CELLS
				? grid.session.query("copyHtml", { sheet, range }).then(answer => {
						if (answer.html === null) {
							throw new RangeError("tooLarge")
						}

						return sanitizeSheetClipboard(answer.html)
					})
				: null

		const written =
			typeof ClipboardItem === "function"
				? navigator.clipboard
						.write([
							new ClipboardItem({
								"text/plain": text.then(value => new Blob([value], { type: "text/plain" })),
								...(html !== null && { "text/html": html.then(value => new Blob([value], { type: "text/html" })) })
							})
						])
						// HTML too long for the clipboard: the text alone (a text that failed fails again here).
						.catch(() => text.then(value => navigator.clipboard.writeText(value)))
				: text.then(value => navigator.clipboard.writeText(value))

		return written.then(
			(): SheetClipboardResult => "done",
			(error: unknown): SheetClipboardResult => (error instanceof RangeError ? "tooLarge" : "blocked")
		)
	}

	function pasteData(text: string, html: string, values: boolean): void {
		const { model: grid } = latest.current
		const { sheet, selection } = grid.getSnapshot()
		const range = selection.ranges[selection.ranges.length - 1]

		if (range === undefined || !latest.current.canEdit || grid.cellless()) {
			return
		}

		const at = { row: range.startRow, col: range.startCol }
		const clip = lastClip.current === null || values ? {} : { clip: lastClip.current }

		void grid.intent()
		void grid.command(
			html === "" || html.length > MAX_PASTE_HTML
				? { type: "clipboard.paste", sheet, at, text, ...clip }
				: { type: "clipboard.pasteHtml", sheet, at, text, html: sanitizeSheetClipboard(html), ...clip }
		)
	}

	async function paste(values: boolean): Promise<SheetClipboardResult> {
		if (!latest.current.canEdit) {
			return "done"
		}

		const content = await readClipboard()

		if (content === null) {
			return "blocked"
		}

		if (values ? content.text !== "" : content.text !== "" || content.html !== "") {
			pasteData(content.text, values ? "" : content.html, values)
		}

		return "done"
	}

	const commands = useLatestRef({ copy, pasteData })

	useEffect(() => {
		function focusedGrid(): boolean {
			const active = document.activeElement

			return active !== null && active.getAttribute("role") === "grid" && container.current?.contains(active) === true
		}

		function listener(event: ClipboardEvent): void {
			if (event.defaultPrevented || !focusedGrid()) {
				return
			}

			event.preventDefault()

			switch (event.type) {
				case "copy":
				case "cut":
					void commands.current.copy(event.type === "cut").then(result => {
						if (result !== "done") {
							latest.current.onRefused(result === "tooLarge" ? "tooLarge" : "failed")
						}
					})
					break
				case "paste":
					commands.current.pasteData(
						event.clipboardData?.getData("text/plain") ?? "",
						event.clipboardData?.getData("text/html") ?? "",
						false
					)
					break
			}
		}

		document.addEventListener("copy", listener)
		document.addEventListener("cut", listener)
		document.addEventListener("paste", listener)

		return () => {
			document.removeEventListener("copy", listener)
			document.removeEventListener("cut", listener)
			document.removeEventListener("paste", listener)
		}
	}, [latest, commands, container])

	return { copy, paste }
}
