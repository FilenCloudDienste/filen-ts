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
}

// A style element's content as Excel writes it, inside an HTML comment (for browsers without CSS): DOMPurify drops an
// element whose content holds a comment's end, so the markers go first. The rules are the same without them.
const STYLE_ELEMENT = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/giu
const COMMENT_MARKERS = /<!--|-->/gu

function uncommentStyles(html: string): string {
	return html.replace(
		STYLE_ELEMENT,
		(_whole, open: string, css: string, close: string) => open + css.replace(COMMENT_MARKERS, "") + close
	)
}

export function createSheetClipboardSanitizer(purifier: SheetClipboardPurifier): (html: string) => string {
	return html =>
		purifier.sanitize(uncommentStyles(html), {
			ALLOWED_TAGS: [...SHEET_CLIPBOARD_ALLOWED_TAGS],
			ALLOWED_ATTR: [...SHEET_CLIPBOARD_ALLOWED_ATTR],
			ALLOW_DATA_ATTR: true,
			// The head's style element holds Excel's cell formats.
			WHOLE_DOCUMENT: true
		})
}
