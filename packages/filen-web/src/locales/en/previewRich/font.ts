// "preview" namespace, rich viewers — the font viewer (ttf, otf, woff, woff2). Spread into preview.ts; same catalog
// rules.
export const previewRichFont = {
	/** Font viewer — tab showing the sample text at several sizes */
	previewFontTabSpecimen: "Specimen",
	/** Font viewer — tab showing every character the font draws */
	previewFontTabGlyphs: "Glyphs",
	/** Font viewer — tab showing the font's names and facts */
	previewFontTabInfo: "Info",
	/** Font viewer — placeholder of the field whose text the specimen shows */
	previewFontSamplePlaceholder: "Type to preview…",
	/** Font viewer — accessible name of the field whose text the specimen shows */
	previewFontSampleLabel: "Preview text",
	/** Font viewer — the specimen's text before the user types, when the font draws it */
	previewFontPangram: "The quick brown fox jumps over the lazy dog",
	/** Font viewer — size label in front of a specimen line, in pixels */
	previewFontSampleSize: "{{size}} px",
	/** Font viewer — header line: how many glyphs the font holds */
	previewFontGlyphCount_one: "{{count, number}} glyph",
	previewFontGlyphCount_other: "{{count, number}} glyphs",
	/** Font viewer — heading over the sliders of a variable font's axes */
	previewFontAxes: "Variable axes",
	/** Font viewer — the font file could not be loaded by the browser; shown with Download */
	previewFontLoadFailed: "This font couldn't be loaded.",
	/** Font viewer — the font's names and facts could not be read */
	previewFontInfoFailed: "This font's details couldn't be read.",
	/** Font viewer — the glyphs tab of a font that maps no characters */
	previewFontNoGlyphs: "This font maps no characters.",
	/** Font viewer — format: TrueType outlines in a .ttf */
	previewFontFormatTrueType: "TrueType",
	/** Font viewer — format: OpenType with CFF outlines */
	previewFontFormatOpenType: "OpenType (CFF)",
	/** Font viewer — format: OpenType with CFF2 outlines */
	previewFontFormatOpenType2: "OpenType (CFF2)",
	/** Font viewer — format: a font of bitmap glyphs only */
	previewFontFormatBitmap: "Bitmap font",
	/** Font viewer — format: a WOFF web font */
	previewFontFormatWoff: "WOFF",
	/** Font viewer — format: a WOFF2 web font */
	previewFontFormatWoff2: "WOFF2",
	/** Font viewer, Info — section of the font's facts */
	previewFontInfoSectionFont: "Font",
	/** Font viewer, Info — section of the names the font carries */
	previewFontInfoSectionNames: "Names",
	/** Font viewer, Info — section of a variable font's axes */
	previewFontInfoSectionAxes: "Variable axes",
	/** Font viewer, Info — the file's format */
	previewFontInfoFormat: "Format",
	/** Font viewer, Info — the kind of outlines the glyphs are drawn from */
	previewFontInfoOutlines: "Outlines",
	/** Font viewer, Info — outlines: TrueType quadratic curves */
	previewFontOutlinesTrueType: "TrueType",
	/** Font viewer, Info — outlines: Compact Font Format */
	previewFontOutlinesCff: "CFF",
	/** Font viewer, Info — outlines: Compact Font Format 2 */
	previewFontOutlinesCff2: "CFF2",
	/** Font viewer, Info — outlines: bitmaps only */
	previewFontOutlinesBitmap: "Bitmaps",
	/** Font viewer, Info — how many glyphs the font holds */
	previewFontInfoGlyphs: "Glyphs",
	/** Font viewer, Info — how many characters the font maps to a glyph */
	previewFontInfoCharacters: "Characters",
	/** Font viewer, Info — the font's design grid */
	previewFontInfoUnitsPerEm: "Units per em",
	/** Font viewer, Info — the font's weight class (100–900) */
	previewFontInfoWeight: "Weight",
	/** Font viewer, Info — upright or italic */
	previewFontInfoStyle: "Style",
	/** Font viewer, Info — style value */
	previewFontStyleItalic: "Italic",
	/** Font viewer, Info — style value */
	previewFontStyleUpright: "Upright",
	/** Font viewer, Info — what the font's license flags allow when it is embedded in a document */
	previewFontInfoEmbedding: "Embedding",
	/** Font viewer, Info — embedding value: no restriction */
	previewFontEmbeddingInstallable: "Installable",
	/** Font viewer, Info — embedding value: not to be embedded */
	previewFontEmbeddingRestricted: "Restricted",
	/** Font viewer, Info — embedding value: embedded documents may be viewed and printed only */
	previewFontEmbeddingPreviewPrint: "Preview and print",
	/** Font viewer, Info — embedding value: embedded documents may be edited */
	previewFontEmbeddingEditable: "Editable",
	/** Font viewer, Info — an axis's range and default */
	previewFontAxisRange: "{{min}} – {{max}}, default {{value}}",
	/** Font viewer, Info — name record 0 */
	previewFontName0: "Copyright",
	/** Font viewer, Info — name record 1 */
	previewFontName1: "Family",
	/** Font viewer, Info — name record 2 */
	previewFontName2: "Subfamily",
	/** Font viewer, Info — name record 3 */
	previewFontName3: "Unique ID",
	/** Font viewer, Info — name record 4 */
	previewFontName4: "Full name",
	/** Font viewer, Info — name record 5 */
	previewFontName5: "Version",
	/** Font viewer, Info — name record 6 */
	previewFontName6: "PostScript name",
	/** Font viewer, Info — name record 7 */
	previewFontName7: "Trademark",
	/** Font viewer, Info — name record 8 */
	previewFontName8: "Manufacturer",
	/** Font viewer, Info — name record 9 */
	previewFontName9: "Designer",
	/** Font viewer, Info — name record 10 */
	previewFontName10: "Description",
	/** Font viewer, Info — name record 11 */
	previewFontName11: "Vendor URL",
	/** Font viewer, Info — name record 12 */
	previewFontName12: "Designer URL",
	/** Font viewer, Info — name record 13 */
	previewFontName13: "License",
	/** Font viewer, Info — name record 14 */
	previewFontName14: "License URL",
	/** Font viewer, Info — name record 16 */
	previewFontName16: "Typographic family",
	/** Font viewer, Info — name record 17 */
	previewFontName17: "Typographic subfamily",
	/** Font viewer, Info — name record 19 */
	previewFontName19: "Sample text"
} as const
