import type { DocxGateReason, DocxOpenFailure, DocxVariant } from "../../core/docx/index"
import type { DecorationValue } from "../../core/docx/layout/index"
import type { FontFaceDescriptor } from "../../core/fonts/index"
import type { MathElement } from "../../core/math/index"
import type { DocxAnnotations } from "./annotations"
import type { DocxPageData, DocxTextStyle, DocxLinkTarget } from "../../core/docx/layout/pageData"
import type { DrawingData } from "../../core/drawingml/data"

// The page and drawing data are core's (the engine builds them); re-exported here for the renderers.
export type { DocxLinkTarget, DocxPageData, DocxTextStyle } from "../../core/docx/layout/pageData"
export { LINK_INTS } from "../../core/docx/layout/pageData"
export type { DrawingData } from "../../core/drawingml/data"

// What the DOCX engine sends to a renderer. Everything here is plain data (numbers, enums, strings and
// typed arrays) so it crosses a worker boundary by structured clone, with the typed arrays transferred. A
// renderer still validates what it turns into DOM: colours, sizes and tree shapes are checked again on
// arrival.

// The engine reports an encrypted package by why it cannot open it, never as "encrypted" (that stays for a
// host's own checks). Unlocking (encrypted.ts) comes before the engine is given the decrypted package.
//   needsPassword          password encryption, opened once given the password
//   rightsManaged          IRM / a sensitivity label
//   unsupportedEncryption  an encryption scheme Filen does not implement
//   damagedEncryption      a malformed encrypted container
export type DocxErrorReason =
	DocxOpenFailure | "needsPassword" | "rightsManaged" | "unsupportedEncryption" | "damagedEncryption" | "malformed" | "failed"

export interface DocxOpenInfo {
	readonly variant: DocxVariant
	// Why the document would open view-only (gate 0); informational for the viewer.
	readonly gate: readonly DocxGateReason[]
	// Pages expected before layout knows: Word's recorded page breaks + 1.
	readonly estimatedPages: number
	// The first section's page size (px), for placeholders of pages not laid out yet.
	readonly pageWidth: number
	readonly pageHeight: number
	// Uncompressed size of the main document part, from the zip directory (a host can tell how heavy any
	// other renderer would find the file).
	readonly mainPartBytes: number
	// How many comments and tracked changes the document holds (an app offers its markup controls before
	// the annotations themselves are ready).
	readonly comments?: number
	readonly revisions?: number
	// Of the tracked changes, those to formatting (run, paragraph, numbering, table properties).
	readonly formatting?: number
}

export type DocxObjectData =
	// alt: the picture's accessible name (its alternative text, else its title), absent for none.
	| { readonly kind: "drawing"; readonly id: number; readonly drawing: DrawingData; readonly alt?: string }
	// fontSize: px of the run holding the equation.
	| { readonly kind: "math"; readonly id: number; readonly tree: MathElement; readonly fontSize: number }
	| { readonly kind: "separator"; readonly id: number }
	| { readonly kind: "checkbox"; readonly id: number; readonly checked: boolean }
	| { readonly kind: "placeholder"; readonly id: number; readonly reason: string }

export interface DocxMedia {
	readonly bytes: Uint8Array
	// The image MIME type a renderer may show it as, or "" when it cannot be shown natively.
	readonly type: string
}

export interface DocxLocation {
	readonly page: number
	// px from the page's top.
	readonly y: number
}

// A face to register in the renderer's realm under the same alias the layout measured with.
export type DocxFontFace =
	| { readonly kind: "bytes"; readonly face: FontFaceDescriptor; readonly bytes: Uint8Array }
	| { readonly kind: "local"; readonly face: FontFaceDescriptor; readonly name: string }

export type DocxEvent =
	| { readonly type: "opened"; readonly info: DocxOpenInfo }
	| { readonly type: "fonts"; readonly faces: readonly DocxFontFace[] }
	| {
			readonly type: "pages"
			readonly pages: readonly DocxPageData[]
			// Appended to the session's tables, in order (the pages' indices refer to the whole tables).
			readonly styles: readonly DocxTextStyle[]
			readonly decorations: readonly DecorationValue[]
			readonly links: readonly DocxLinkTarget[]
			// Every page is laid out; pageCount is the final count.
			readonly final: boolean
			readonly pageCount: number
	  }
	// mainPartBytes: as in DocxOpenInfo, when the package got that far.
	| { readonly type: "error"; readonly reason: DocxErrorReason; readonly message: string; readonly mainPartBytes?: number }

// The engine's side of an open document, as a renderer calls it (worker or in-thread).
export interface DocxSessionApi {
	objects(ids: readonly number[]): Promise<readonly DocxObjectData[]>
	media(partName: string): Promise<DocxMedia | null>
	locate(anchor: string): Promise<DocxLocation | null>
	// Every match of `query` in the whole document (laid out so far), as FIND_INTS per match.
	find(query: string, options?: DocxFindOptions): Promise<Int32Array>
	// Comments and tracked changes with their boxes on the pages, once every page is laid out (null when
	// the document closed first).
	annotations?(): Promise<DocxAnnotations | null>
	close(): void
}

export interface DocxFindOptions {
	readonly caseSensitive?: boolean
	// Stops after this many matches and one more, which tells that there are more (default DOCX_FIND_LIMIT).
	readonly limit?: number
}

// Matches a find shows at most (a counter shows "10,000+" beyond).
export const DOCX_FIND_LIMIT = 10_000

// Per match: page, source (the page's paragraph), start and end offsets in the source's text.
export const FIND_INTS = 4

export interface DocxOpenOptions {
	// Lay out tracked changes accepted (Final, what Simple Markup shows), rejected (the original text) or
	// inline with insertions and deletions marked (All Markup).
	readonly view?: "final" | "original" | "markup"
	// Where the host serves each bundled font (path under assets/fonts -> same-origin URL).
	readonly fontUrls?: Readonly<Record<string, string>>
	// Keep the model after layout (editing needs it). A viewer lets the engine drop it once every page and
	// object is prepared, keeping only what find, links, bookmarks and images need.
	readonly retain?: boolean
	// The file's format: an OpenDocument text document ("odt") is translated in the engine's realm and shown
	// through the same layout (default "docx": any word-processing package).
	readonly format?: "docx" | "odt"
}
