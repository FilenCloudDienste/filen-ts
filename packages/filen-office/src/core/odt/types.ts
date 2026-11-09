import type { OdfFacts, OdfEncryption, OdfOpenFailure } from "../odf/index"
import type { LinkedPart } from "../opc/package"

// What a translated block approximates or leaves out. A block with any of these is shown as LibreOffice would
// show it as closely as WordprocessingML allows, and must not be re-serialized from the translation on save.
export type OdtLossyReason =
	// style:next-style-name chains beyond a first page (A → B → C), or a first page whose layout differs.
	| "masterPageChain"
	// Headers or footers of a fixed height (svg:height): WordprocessingML headers always grow.
	| "fixedHeaderHeight"
	// style:line-spacing (leading added to each line), approximated as a multiple.
	| "lineSpacingLeading"
	// fo:text-transform lowercase or capitalize.
	| "textTransform"
	// Text rotation, combining, ruby or a character effect without an equivalent.
	| "textEffect"
	// A text property WordprocessingML has no form for (an overline, a line-through colour, East Asian bold, italic or
	// size apart from the Latin text's, a raise with its own size, kerning...): not shown; a rewrite keeps it from
	// the source span style.
	| "untranslatedText"
	// draw:chain-next-name: text flowing from one text box into another.
	| "chainedTextBox"
	// Frames anchored to another frame, or to a page other than the first, or that flow with the text
	// (style:flow-with-text true: kept on their anchor's page, not inside its text area).
	| "frameAnchor"
	// A chart, formula or embedded object shown from its replacement image or as a placeholder.
	| "embeddedObject"
	// An image whose format the viewer cannot draw, shown as a placeholder.
	| "unsupportedImage"
	// Cropping (fo:clip) or image adjustments (luminance, contrast, gamma, colour mode).
	| "imageAdjustment"
	// An index (table of contents, alphabetical, bibliography...) kept as the entries it shows: its definition
	// (the *-source element) and its link to what it indexes are left out.
	| "index"
	// A bookmark between blocks, left out (WordprocessingML's would have to move into a paragraph).
	| "bookmark"
	// Shapes drawn through their geometry: connectors, measures, groups flattened, unknown preset types.
	| "shapeApproximated"
	// Fields with no WordprocessingML equivalent (variables, sequences, conditional text, database fields):
	// their shown result is kept as text.
	| "fieldAsText"
	// text:section protection, unbalanced columns, or section-level note collection.
	| "sectionProperties"
	// More than nine list levels, or a list label WordprocessingML cannot express.
	| "listLevel"
	// Tables wider than 63 columns, repeated rows cut short, or a table that may not break between rows.
	| "tableLimit"
	// A table's space above or below (fo:margin-top/bottom) with no paragraph beside it to carry it: not shown.
	| "tableSpacing"
	// Tracked changes beyond inserted and deleted text (format changes, deleted paragraphs).
	| "trackedChange"
	// An element the translator does not know; its text content is kept.
	| "unknownElement"

export interface OdtOrigin {
	// The ODF stream the block was read from, and its byte span [start, end) there.
	readonly stream: "content.xml" | "styles.xml"
	readonly start: number
	readonly end: number
	// The WordprocessingML part written for it, and the range [first, first + count) of top-level blocks
	// (w:body, w:hdr or w:ftr children) it became; count 0 for a block that wrote nothing there (tracked-change
	// records, declarations).
	readonly part: string
	readonly first: number
	readonly count: number
	readonly lossy: readonly OdtLossyReason[]
	// A block of the body: the translator's state as it began (Translator.blockState).
	readonly state?: string | undefined
}

export type OdtOpenFailure = OdfOpenFailure | "malformed"

export interface OdtTranslation {
	// The WordprocessingML package's parts by zip entry name; pictures stay in the ODF archive until read.
	readonly parts: ReadonlyMap<string, Uint8Array | LinkedPart>
	readonly origins: readonly OdtOrigin[]
	// The origins' byte offsets are into content.xml as stored (false: as transcoded from UTF-16).
	readonly originsExact: boolean
	readonly facts: OdfFacts
	// Reasons any block was lossy, with how many blocks each; a reason only the document's styles or note
	// settings have counts once.
	readonly lossy: ReadonlyMap<OdtLossyReason, number>
	// Embedded objects shown from a replacement or as a placeholder, by kind.
	readonly objects: ReadonlyMap<string, number>
	// Each w:num's ODF list style and the stream naming it (the outline style is "\u0000outline").
	readonly numbering: ReadonlyMap<number, { readonly style: string; readonly scope: "styles" | "content" }>
	// Picture parts by the package entry they hold.
	readonly media: ReadonlyMap<string, string>
	// Each section (each w:sectPr, in order) by the master page and page layout it was read from.
	// Each section's page style (its first page's follower, when the first is a first page), page layout, and the
	// master page it starts with.
	readonly sections: readonly { readonly master: string; readonly layout: string | undefined; readonly start?: string }[]
	// The translator's state past the body's last block (Translator.blockState).
	readonly endState?: string | undefined
	// The space above and below (twips) of each table of the body that has some, by its index among the body's blocks:
	// the paragraphs beside it carry it (Translator.spaceTable).
	readonly tableSpacing?: ReadonlyMap<number, OdtTableSpacing>
}

export interface OdtTableSpacing {
	readonly top: number
	readonly bottom: number
}

export type OdtTranslateResult =
	| { readonly ok: true; readonly translation: OdtTranslation }
	| { readonly ok: false; readonly reason: OdtOpenFailure; readonly message: string; readonly encryption?: OdfEncryption }
