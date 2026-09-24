import { parse, type HTMLElement } from "node-html-better-parser"
import { v4 as uuidv4 } from "uuid"
import { decodeHtmlEntities } from "./htmlEntities"

export type ChecklistItem = {
	checked: boolean
	content: string
	id: string
}

export type Checklist = ChecklistItem[]

// Rows are escaped on write and decoded on read, so text with `<`, `>` or `&` survives the round trip.
function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Older mobile builds stored rows unescaped, and the parser's own `.text` would also expand legacy names
// that lack the ";": "cut&copy" read as "cut©", "Issue&#42" as "Issue*".
function rowContent(li: HTMLElement): string {
	return decodeHtmlEntities(li.rawText).trim()
}

// Visits every row in document order; `visit` returning true stops the walk.
function walkRows(html: string, visit: (checked: boolean, content: string) => boolean): void {
	for (const ul of parse(html).querySelectorAll("ul")) {
		const checked = ul.getAttribute("data-checked") === "true"

		for (const li of ul.querySelectorAll("li")) {
			if (visit(checked, rowContent(li))) {
				return
			}
		}
	}
}

export class ChecklistParser {
	public parse(html: string): Checklist {
		try {
			const checklist: Checklist = []

			walkRows(html, (checked, content) => {
				checklist.push({
					checked,
					content,
					id: uuidv4()
				})

				return false
			})

			return checklist
		} catch {
			return []
		}
	}

	// The first row with text, "" when there is none. Stops at that row and builds no list or ids.
	public firstNonEmptyContent(html: string): string {
		let first = ""

		try {
			walkRows(html, (_checked, content) => {
				if (content.length === 0) {
					return false
				}

				first = content

				return true
			})
		} catch {
			return ""
		}

		return first
	}

	public stringify(checklist: Checklist): string {
		if (checklist.length === 0) {
			return ""
		}

		let html = ""
		let currentCheckedStatus: boolean | null = null

		for (const item of checklist) {
			if (currentCheckedStatus !== item.checked) {
				if (currentCheckedStatus !== null) {
					html += "</ul>"
				}

				html += `<ul data-checked="${item.checked}">`

				currentCheckedStatus = item.checked
			}

			const trimmed = escapeHtml(item.content.trim())

			html += `<li>${trimmed.length > 0 ? trimmed : "<br>"}</li>`
		}

		if (checklist.length > 0) {
			html += "</ul>"
		}

		return html
	}
}

export const checklistParser = new ChecklistParser()

export default checklistParser
