import { parseLength, parsePercent, parseRelativeLength, type OdfProperties } from "../odf/index"
import { MarkupFlow, type Flow } from "./flow"
import { border, modeRtl } from "./props"
import type { Translator } from "./translator"
import { twips } from "./wml"

// table:table as w:tbl (Part 3 §9.1). The table's width resolves as LibreOffice lays it out: aligned to the
// margins it fills the text width less its own margins, otherwise style:rel-width of the available width or
// style:width; columns share it by style:rel-column-width (else by their absolute widths, scaled). Spans
// become gridSpan, rows spanned become vMerge, and covered cells disappear into them.

// WordprocessingML's column limit (ECMA-376 Part 1 §17.4.48 note: 63 grid columns), and how many copies of
// one repeated row are written.
const MAX_COLUMNS = 63
const MAX_ROW_REPEAT = 1000
// LibreOffice's narrowest column (sw MINLAY, 23 twips): no column is laid out narrower, so a table narrower than
// that per column grows (measured over UNO: a zero-width table of n columns is n × 23 twips, columns equal).
const MIN_COLUMN = 23 / 20

interface ColumnInfo {
	readonly absolute: number | undefined
	readonly relative: number | undefined
}

function colorOf(value: string | undefined): string | undefined {
	return value !== undefined && /^#[0-9a-fA-F]{6}$/.test(value) ? value.slice(1).toUpperCase() : undefined
}

function insertPageBreak(markup: string): string {
	// The first paragraph of the first cell carries a page break before the table.
	const at = markup.indexOf("<w:p>")

	if (at < 0) return markup

	const pPr = markup.indexOf("<w:pPr>", at)
	const contentStart = at + "<w:p>".length

	if (pPr === contentStart) {
		const styleEnd = markup.startsWith("<w:pStyle", pPr + 7) ? markup.indexOf("/>", pPr) + 2 : pPr + 7

		return `${markup.slice(0, styleEnd)}<w:pageBreakBefore/>${markup.slice(styleEnd)}`
	}

	return `${markup.slice(0, contentStart)}<w:pPr><w:pageBreakBefore/></w:pPr>${markup.slice(contentStart)}`
}

export function translateTable(translator: Translator, node: number, flow: Flow): void {
	const document = translator.document
	const attributes = translator.attributes(node)
	const styleName = attributes.get("table:style-name")
	const resolved = translator.resolver.resolve("table", styleName, translator.scope)
	const properties = resolved.properties("table").attributes
	let pageBreak = translator.breakAfter

	translator.breakAfter = false

	if (flow.body) {
		const master = translator.resolver.inherited("table", styleName, translator.scope, "style:master-page-name")

		if (master !== undefined && master !== "" && translator.sheet.masterPages.has(master)) {
			pageBreak = !translator.pages.pageStyle(master, properties.get("style:page-number"))
		} else {
			translator.pages.begin()
		}
	}

	if (properties.get("fo:break-before") === "page") pageBreak = true
	if (properties.get("fo:break-after") === "page") translator.breakAfter = true
	if (properties.get("style:may-break-between-rows") === "false") translator.lossy("tableLimit")

	// Columns and rows, header rows marked.
	const columns: ColumnInfo[] = []
	const rows: { readonly node: number; readonly header: boolean }[] = []
	const collect = (container: number, header: boolean): void => {
		for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
			const name = translator.name(child)

			if (name === "table:table-column") {
				const column = translator.attributes(child)
				const style = translator.resolver
					.resolve("table-column", column.get("table:style-name"), translator.scope)
					.properties("table-column").attributes
				const info = {
					absolute: parseLength(style.get("style:column-width")),
					relative: parseRelativeLength(style.get("style:rel-column-width"))
				}
				const repeat = Math.max(1, Number(column.get("table:number-columns-repeated") ?? "1") || 1)

				for (let k = 0; k < repeat && columns.length <= MAX_COLUMNS; k++) columns.push(info)
			} else if (name === "table:table-columns" || name === "table:table-header-columns" || name === "table:table-column-group") {
				collect(child, header)
			} else if (name === "table:table-row") {
				const repeat = Math.max(1, Number(translator.attributes(child).get("table:number-rows-repeated") ?? "1") || 1)

				if (repeat > MAX_ROW_REPEAT) translator.lossy("tableLimit")

				for (let k = 0; k < Math.min(repeat, MAX_ROW_REPEAT); k++) rows.push({ node: child, header })
			} else if (name === "table:table-header-rows") {
				collect(child, true)
			} else if (name === "table:table-rows" || name === "table:table-row-group") {
				collect(child, header)
			}
		}
	}

	collect(node, false)

	if (rows.length === 0) return

	if (columns.length > MAX_COLUMNS) {
		translator.lossy("tableLimit")
		columns.length = MAX_COLUMNS
	}

	// Rows may hold more cells than columns are declared.
	let gridCount = columns.length

	for (const row of rows) {
		let count = 0

		for (let cell = document.firstChildElement(row.node); cell >= 0; cell = document.nextSiblingElement(cell)) {
			const name = translator.name(cell)

			if (name === "table:table-cell" || name === "table:covered-table-cell") {
				count += Math.max(1, Number(translator.attributes(cell).get("table:number-columns-repeated") ?? "1") || 1)
			}
		}

		gridCount = Math.max(gridCount, Math.min(count, MAX_COLUMNS))
	}

	while (columns.length < gridCount) columns.push({ absolute: undefined, relative: undefined })

	// Width.
	const available = translator.width
	const align = properties.get("table:align") ?? "margins"
	const marginLeft = parseLength(properties.get("fo:margin-left")) ?? 0
	const marginRight = parseLength(properties.get("fo:margin-right")) ?? 0
	const absoluteSum = columns.reduce((sum, column) => sum + (column.absolute ?? 0), 0)
	const relWidth = parsePercent(properties.get("style:rel-width"))
	let width: number

	if (align === "margins") width = available - marginLeft - marginRight
	else if (relWidth !== undefined) width = (available * relWidth) / 100
	else width = parseLength(properties.get("style:width")) ?? (absoluteSum > 0 ? absoluteSum : available)

	const relativeSum = columns.every(column => column.relative !== undefined)
		? columns.reduce((sum, column) => sum + (column.relative ?? 0), 0)
		: 0
	const widths = columns.map(column => {
		if (relativeSum > 0) return Math.max(MIN_COLUMN, (width * (column.relative ?? 0)) / relativeSum)
		if (absoluteSum > 0) return Math.max(MIN_COLUMN, (width * (column.absolute ?? 0)) / absoluteSum)

		return Math.max(MIN_COLUMN, width / columns.length)
	})

	width = widths.reduce((sum, item) => sum + item, 0)
	const jc = align === "center" ? "center" : align === "right" ? "right" : "left"
	const indent = align === "left" || align === "margins" ? marginLeft : 0
	const background = colorOf(properties.get("fo:background-color"))
	// Separate borders (table:border-model, separating where nothing says: LibreOffice, measured) as cell spacing of zero:
	// each cell keeps its own borders, which then both take room between rows.
	const separating = (properties.get("table:border-model") ?? "separating") === "separating"
	let xml = `<w:tbl><w:tblPr><w:tblW w:w="${twips(width)}" w:type="dxa"/><w:jc w:val="${jc}"/>${separating ? '<w:tblCellSpacing w:w="0" w:type="dxa"/>' : ""}${indent !== 0 ? `<w:tblInd w:w="${twips(indent)}" w:type="dxa"/>` : ""}${background === undefined ? "" : `<w:shd w:val="clear" w:color="auto" w:fill="${background}"/>`}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000"/></w:tblPr><w:tblGrid>`

	for (const columnWidth of widths) xml += `<w:gridCol w:w="${Math.max(1, twips(columnWidth))}"/>`

	xml += "</w:tblGrid>"

	// Rows still spanned from above, per grid column, with the spanning cell's column span.
	const remaining = new Int32Array(gridCount)
	const spanAt = new Int32Array(gridCount).fill(1)
	const spanWidth = (from: number, span: number): number => widths.slice(from, from + span).reduce((sum, item) => sum + item, 0)
	let firstCell = true

	for (const row of rows) {
		const rowAttributes = translator.attributes(row.node)
		const rowProperties = translator.resolver
			.resolve("table-row", rowAttributes.get("table:style-name"), translator.scope)
			.properties("table-row").attributes
		const exact = parseLength(rowProperties.get("style:row-height"))
		const minimum = parseLength(rowProperties.get("style:min-row-height"))
		let trPr = ""

		if (rowProperties.get("fo:keep-together") === "always") trPr += "<w:cantSplit/>"
		if (exact !== undefined)
			trPr += `<w:trHeight w:val="${twips(exact)}" w:hRule="${rowProperties.get("style:use-optimal-row-height") === "true" ? "atLeast" : "exact"}"/>`
		else if (minimum !== undefined) trPr += `<w:trHeight w:val="${twips(minimum)}" w:hRule="atLeast"/>`
		if (row.header) trPr += "<w:tblHeader/>"

		const rowBackground = colorOf(rowProperties.get("fo:background-color"))
		let rowXml = `<w:tr>${trPr === "" ? "" : `<w:trPr>${trPr}</w:trPr>`}`
		let column = 0
		let skip = 0
		let cells = 0

		for (let cell = document.firstChildElement(row.node); cell >= 0 && column < gridCount; cell = document.nextSiblingElement(cell)) {
			const name = translator.name(cell)

			if (name !== "table:table-cell" && name !== "table:covered-table-cell") continue

			const cellAttributes = translator.attributes(cell)
			const repeat = Math.max(1, Number(cellAttributes.get("table:number-columns-repeated") ?? "1") || 1)

			for (let copy = 0; copy < repeat && column < gridCount; copy++) {
				if (name === "table:covered-table-cell") {
					if (skip > 0) {
						skip--

						continue
					}

					if ((remaining[column] ?? 0) > 0) {
						const span = Math.min(spanAt[column] ?? 1, gridCount - column)

						remaining[column] = (remaining[column] ?? 1) - 1
						rowXml += `<w:tc><w:tcPr><w:tcW w:w="${twips(spanWidth(column, span))}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}<w:vMerge/></w:tcPr><w:p/></w:tc>`
						cells++
						column += span
						skip = span - 1

						continue
					}

					rowXml += `<w:tc><w:tcPr><w:tcW w:w="${twips(spanWidth(column, 1))}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`
					cells++
					column++

					continue
				}

				skip = 0

				const span = Math.max(
					1,
					Math.min(gridCount - column, Number(cellAttributes.get("table:number-columns-spanned") ?? "1") || 1)
				)
				const rowSpan = Math.max(1, Number(cellAttributes.get("table:number-rows-spanned") ?? "1") || 1)
				const cellProperties = translator.resolver
					.resolve("table-cell", cellAttributes.get("table:style-name"), translator.scope)
					.properties("table-cell")
				const cellXml = cellMarkup(translator, cell, cellProperties, spanWidth(column, span), span, rowSpan, rowBackground)

				if (rowSpan > 1) {
					remaining[column] = rowSpan - 1
					spanAt[column] = span
				}

				rowXml += firstCell && pageBreak ? insertPageBreak(cellXml) : cellXml
				firstCell = false
				cells++
				column += span
				skip = span - 1
			}
		}

		if (cells === 0)
			rowXml += `<w:tc><w:tcPr><w:tcW w:w="${twips(width)}" w:type="dxa"/><w:gridSpan w:val="${gridCount}"/></w:tcPr><w:p/></w:tc>`

		xml += `${rowXml}</w:tr>`
	}

	flow.add({ kind: "raw", xml: `${xml}</w:tbl>` })
}

function cellMarkup(
	translator: Translator,
	cell: number,
	properties: OdfProperties,
	width: number,
	span: number,
	rowSpan: number,
	rowBackground: string | undefined
): string {
	const attributes = properties.attributes
	const sides = ["top", "left", "bottom", "right"] as const
	const padding = (side: string): number => parseLength(attributes.get(`fo:padding-${side}`)) ?? 0
	const margins = sides.map(side => `<w:${side} w:w="${twips(padding(side))}" w:type="dxa"/>`).join("")
	// A side without a border is left unset (not "nil"): the neighbouring cell's border on that edge then shows,
	// as in LibreOffice, which draws each cell's own borders.
	const borders = sides
		.map(side => border(side, attributes.get(`fo:border-${side}`), undefined, attributes.get(`style:border-line-width-${side}`)))
		.filter(markup => !markup.includes('w:val="nil"'))
		.join("")
	const verticalAlign = attributes.get("style:vertical-align")
	const background = colorOf(attributes.get("fo:background-color")) ?? rowBackground
	const writingMode = attributes.get("style:writing-mode")
	const flow = new MarkupFlow()
	const inner = Math.max(1, width - padding("left") - padding("right"))

	const direction = translator.direction

	// A cell setting a direction is its paragraphs' superordinate object for a "page" writing mode.
	translator.direction = modeRtl(writingMode) ?? direction
	translator.widths.push(inner)
	translator.storyBlocks(cell, flow)
	translator.widths.pop()
	translator.direction = direction

	let content = flow.xml()

	if (!flow.endsWithParagraph) content += "<w:p/>"

	return `<w:tc><w:tcPr><w:tcW w:w="${twips(width)}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}${rowSpan > 1 ? '<w:vMerge w:val="restart"/>' : ""}${borders === "" ? "" : `<w:tcBorders>${borders}</w:tcBorders>`}${background === undefined ? "" : `<w:shd w:val="clear" w:color="auto" w:fill="${background}"/>`}<w:tcMar>${margins}</w:tcMar>${writingMode === "tb-rl" ? '<w:textDirection w:val="tbRl"/>' : ""}${verticalAlign === "middle" ? '<w:vAlign w:val="center"/>' : verticalAlign === "bottom" ? '<w:vAlign w:val="bottom"/>' : ""}</w:tcPr>${content}</w:tc>`
}
