import { utf8 } from "./objects"

// The document's XMP metadata stream (ISO 32000-1 §14.3.2; ISO 16684-1): title, author, subject, keywords and
// producer as the Info dictionary has them (§14.3.3: dc:creator, dc:description, pdf:Keywords), and for tagged
// output the PDF/UA identification ISO 14289-1 §5 requires (pdfuaid:part).
export function xmpMetadata(options: {
	readonly title: string | undefined
	readonly author?: string | undefined
	readonly subject?: string | undefined
	readonly keywords?: string | undefined
	// The Info dictionary's CreationDate (§14.3.3: xmp:CreateDate); none in deterministic output.
	readonly created?: Date | undefined
	readonly lang: string | undefined
	readonly pdfua: boolean
}): Uint8Array {
	const title =
		options.title === undefined
			? ""
			: `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(options.title)}</rdf:li></rdf:Alt></dc:title>\n`
	const author =
		options.author === undefined ? "" : `<dc:creator><rdf:Seq><rdf:li>${escapeXml(options.author)}</rdf:li></rdf:Seq></dc:creator>\n`
	const subject =
		options.subject === undefined
			? ""
			: `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(options.subject)}</rdf:li></rdf:Alt></dc:description>\n`
	const keywords = options.keywords === undefined ? "" : `<pdf:Keywords>${escapeXml(options.keywords)}</pdf:Keywords>\n`
	const language =
		options.lang === undefined ? "" : `<dc:language><rdf:Bag><rdf:li>${escapeXml(options.lang)}</rdf:li></rdf:Bag></dc:language>\n`
	// ISO 8601 to the second in UTC, as the Info date is written.
	const created =
		options.created === undefined ? "" : `<xmp:CreateDate>${options.created.toISOString().replace(/\.\d+Z$/u, "Z")}</xmp:CreateDate>\n`
	const pdfua = options.pdfua ? "<pdfuaid:part>1</pdfuaid:part>\n" : ""

	return utf8(
		'<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
			'<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
			'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
			'<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n' +
			"<dc:format>application/pdf</dc:format>\n" +
			title +
			author +
			subject +
			language +
			keywords +
			"<pdf:Producer>Filen</pdf:Producer>\n" +
			created +
			pdfua +
			"</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n" +
			'<?xpacket end="w"?>'
	)
}

// XML character data: markup characters escaped, and characters XML 1.0 forbids dropped (a title holds only
// what the document said; a forbidden control character has no XML form).
function escapeXml(text: string): string {
	return text
		.replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
}
