import { FONT_FACES, FO, odfPackage, OFFICE, pageLayout, STYLE, SVG, TEXT, textProperties } from "./odf"
import { templateLocale, type TemplatePaper } from "./locale"
import { zipParts } from "./zip"

// A blank OpenDocument text document (ODF 1.3): one empty paragraph in Calibri 11 pt, the paper of the user's region
// with LibreOffice's 2 cm margins, the user's language as the default. Part 3 §3.4 (office:text), §16.2 default
// style, §16.5 page layout, §16.9 master page. No meta.xml: nothing about the user is written.

const MEDIA_TYPE = "application/vnd.oasis.opendocument.text"

const CONTENT =
	`<office:document-content xmlns:office="${OFFICE}" xmlns:text="${TEXT}" office:version="1.3">` +
	'<office:body><office:text><text:p text:style-name="Standard"/></office:text></office:body></office:document-content>'

function styles(locale: ReturnType<typeof templateLocale>): string {
	return (
		`<office:document-styles xmlns:office="${OFFICE}" xmlns:style="${STYLE}" xmlns:fo="${FO}" xmlns:svg="${SVG}" office:version="1.3">` +
		FONT_FACES +
		`<office:styles><style:default-style style:family="paragraph">${textProperties(locale)}</style:default-style>` +
		'<style:style style:name="Standard" style:family="paragraph" style:class="text"/></office:styles>' +
		`<office:automatic-styles>${pageLayout(locale.paper)}</office:automatic-styles>` +
		'<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>' +
		"</office:document-styles>"
	)
}

export interface BlankOdtOptions {
	// The user's locale (BCP 47): the paper and the default language.
	readonly locale: string
	// The user's paper, in place of the one the locale's region uses.
	readonly paper?: TemplatePaper | undefined
}

export function blankOdt(options: BlankOdtOptions): Promise<Uint8Array> {
	return zipParts(odfPackage(MEDIA_TYPE, CONTENT, styles(templateLocale(options.locale, options.paper))))
}
