import type { Paragraph, TextBody } from "../model"

// The paragraphs the text editor shows for a body: its own, or one empty paragraph for a body with none (an empty
// placeholder or a shape without text), as PowerPoint and Impress give the caret a line in it.
export function editableParagraphs(body: TextBody): Paragraph[] {
	return body.paragraphs.length === 0 ? [{ pPr: {}, runs: [] }] : body.paragraphs
}
