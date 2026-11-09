// Blocks as the translator produces them: a paragraph keeps its pPr apart from its content, so a section
// break (the sectPr closing a section lives in its last paragraph's pPr) can still be added to it.

export interface ParagraphBlock {
	readonly kind: "p"
	// pPr content before rPr (pStyle ... outlineLvl).
	pPr: string
	// The paragraph mark's run properties.
	readonly markRPr: string
	content: string
	sectPr: string
}

export interface RawBlock {
	readonly kind: "raw"
	readonly xml: string
}

export type Block = ParagraphBlock | RawBlock

export function paragraph(pPr: string, markRPr: string, content: string): ParagraphBlock {
	return { kind: "p", pPr, markRPr, content, sectPr: "" }
}

export function blockXml(block: Block): string {
	if (block.kind === "raw") return block.xml

	const inner = `${block.pPr}${block.markRPr === "" ? "" : `<w:rPr>${block.markRPr}</w:rPr>`}${block.sectPr}`

	return `<w:p>${inner === "" ? "" : `<w:pPr>${inner}</w:pPr>`}${block.content}</w:p>`
}

// Where translated blocks go: a story's markup (cells, notes, text boxes, headers) or the document body.
export interface Flow {
	readonly body: boolean
	add(block: Block): void
	// Adds `content` to the end of the last paragraph, or as a paragraph of its own after another block or none.
	appendToLast(content: string): void
}

export class MarkupFlow implements Flow {
	readonly body = false
	readonly blocks: Block[] = []

	add(block: Block): void {
		this.blocks.push(block)
	}

	appendToLast(content: string): void {
		const last = this.blocks[this.blocks.length - 1]

		if (last?.kind === "p") last.content += content
		else this.add(paragraph("", "", content))
	}

	get endsWithParagraph(): boolean {
		return this.blocks[this.blocks.length - 1]?.kind === "p"
	}

	xml(): string {
		let out = ""

		for (const block of this.blocks) out += blockXml(block)

		return out
	}
}
