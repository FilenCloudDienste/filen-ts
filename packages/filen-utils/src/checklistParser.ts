import { parse } from "node-html-better-parser"
import { v4 as uuidv4 } from "uuid"

export type ChecklistItem = {
	checked: boolean
	content: string
	id: string
}

export type Checklist = ChecklistItem[]

export class ChecklistParser {
	public parse(html: string): Checklist {
		try {
			const root = parse(html)
			const ul = root.querySelectorAll("ul")

			if (!ul || ul.length === 0) {
				return []
			}

			const checklist: Checklist = []

			for (const item of ul) {
				const checked = item.getAttribute("data-checked") === "true"
				const li = item.querySelectorAll("li")

				for (const liItem of li) {
					checklist.push({
						checked,
						content: liItem.rawText ? liItem.rawText.trim() : "",
						id: uuidv4()
					})
				}
			}

			return checklist
		} catch {
			return []
		}
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

			const trimmed = item.content.trim()

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
