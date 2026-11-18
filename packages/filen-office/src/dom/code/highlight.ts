import { highlightCode } from "@lezer/highlight"
import type { CodeLanguageId } from "../../core/code/languages"
import { codeLanguage } from "./languages"
import { codeHighlightStyle } from "./theme"

// Static highlighting outside an editor (a notebook's cells, a markdown file's fences): text as runs with the editor's
// highlight classes, to render as spans. The classes come from codeHighlightStyle, whose rules mountCodeHighlightStyle
// adds to a document once; their colours are the --fo-code-* variables, as the editor's are.

export interface CodeRun {
	readonly text: string
	// The highlight classes, "" for plain text.
	readonly classes: string
}

// Larger text stays plain: a parse of it is not worth a frame.
export const HIGHLIGHT_MAX_CHARS = 65_536

// The runs of `text` in language `id`, or null for text past HIGHLIGHT_MAX_CHARS or a language without a parser.
export function highlightCodeRuns(text: string, id: CodeLanguageId): CodeRun[] | null {
	if (text.length > HIGHLIGHT_MAX_CHARS) {
		return null
	}

	const language = codeLanguage(id)

	if (language === null) {
		return null
	}

	const runs: CodeRun[] = []

	highlightCode(
		text,
		language.parser.parse(text),
		codeHighlightStyle,
		(code, classes) => {
			const last = runs[runs.length - 1]

			// Adjacent runs of one class join: fewer spans.
			if (last !== undefined && last.classes === classes) {
				runs[runs.length - 1] = { text: last.text + code, classes }
			} else {
				runs.push({ text: code, classes })
			}
		},
		() => {
			const last = runs[runs.length - 1]

			if (last !== undefined && last.classes === "") {
				runs[runs.length - 1] = { text: `${last.text}\n`, classes: "" }
			} else {
				runs.push({ text: "\n", classes: "" })
			}
		}
	)

	return runs
}

const mounted = new WeakSet<Document>()

// The highlight classes' rules in `document`, once.
export function mountCodeHighlightStyle(document: Document): void {
	const rules = codeHighlightStyle.module?.getRules()

	if (mounted.has(document) || rules === undefined) {
		return
	}

	const style = document.createElement("style")

	style.textContent = rules
	document.head.append(style)
	mounted.add(document)
}
