// The spreadsheet clipboard's sanitizer: HTML pasted into a sheet (from Excel, Google Sheets, LibreOffice, a web
// page) and HTML a sheet copies, cut down to tables, text and what a spreadsheet reads from them. It is never put
// into a document: the sheet's own parser reads the table, values and formats from the result (a style element's
// rules included), so nothing here needs the rich-text sanitizer's style and class hardening. DOMPurify is passed in,
// as for createRichTextSanitizer; hand in an instance of its own (DOMPurify(window)), so another sanitizer's hooks
// never run here.

export const SHEET_CLIPBOARD_ALLOWED_TAGS = [
	"html",
	"head",
	"body",
	"style",
	"meta",
	"table",
	"caption",
	"colgroup",
	"col",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"td",
	"th",
	"br",
	"p",
	"div",
	"span",
	"font",
	"b",
	"strong",
	"i",
	"em",
	"u",
	"s",
	"strike",
	"del",
	"sub",
	"sup",
	"a"
] as const

// Data attributes (Google Sheets' data-sheets-*, this app's data-filen-*) pass as DOMPurify's ALLOW_DATA_ATTR lets them.
export const SHEET_CLIPBOARD_ALLOWED_ATTR = [
	"style",
	"class",
	"colspan",
	"rowspan",
	"align",
	"valign",
	"bgcolor",
	"color",
	"face",
	"size",
	"width",
	"height",
	"href",
	"x:num",
	"x:str",
	"x:bool",
	"sdval",
	"sdnum"
] as const

// The part of DOMPurify this module uses.
export interface SheetClipboardPurifier {
	sanitize(
		dirty: string,
		config: { ALLOWED_TAGS: string[]; ALLOWED_ATTR: string[]; ALLOW_DATA_ATTR: boolean; WHOLE_DOCUMENT: boolean }
	): string
	// What the last run removed: it holds that run's parsed document until cleared.
	removed: unknown[]
}

// A style element's content as Excel writes it, inside an HTML comment (for browsers without CSS): DOMPurify drops an
// element whose content holds a comment's end, so the markers go first. The rules are the same without them. A scan, not
// one regex over the whole element: a lazy body retried from every unclosed opening is quadratic in the paste's length.
const STYLE_OPEN = /<style\b/giu
const STYLE_CLOSE = /<\/style\s*>/giu
const COMMENT_MARKERS = /<!--|-->/gu

function uncommentStyles(html: string): string {
	let result = ""
	let cursor = 0

	for (;;) {
		STYLE_OPEN.lastIndex = cursor

		const open = STYLE_OPEN.exec(html)

		if (!open) {
			break
		}

		const bodyStart = html.indexOf(">", open.index + open[0].length) + 1

		// No later opening has a ">" or a closing tag after it either.
		if (bodyStart === 0) {
			break
		}

		STYLE_CLOSE.lastIndex = bodyStart

		const close = STYLE_CLOSE.exec(html)

		if (!close) {
			break
		}

		result += html.slice(cursor, bodyStart) + html.slice(bodyStart, close.index).replace(COMMENT_MARKERS, "") + close[0]
		cursor = close.index + close[0].length
	}

	return cursor === 0 ? html : result + html.slice(cursor)
}

export function createSheetClipboardSanitizer(purifier: SheetClipboardPurifier): (html: string) => string {
	return html => {
		try {
			return purifier.sanitize(uncommentStyles(html), {
				ALLOWED_TAGS: [...SHEET_CLIPBOARD_ALLOWED_TAGS],
				ALLOWED_ATTR: [...SHEET_CLIPBOARD_ALLOWED_ATTR],
				ALLOW_DATA_ATTR: true,
				// The head's style element holds Excel's cell formats.
				WHOLE_DOCUMENT: true
			})
		} finally {
			purifier.removed.length = 0
		}
	}
}
