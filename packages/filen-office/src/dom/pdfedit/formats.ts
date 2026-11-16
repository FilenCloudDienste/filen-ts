// The documents other than PDF that the engine's "read" role opens, keyed by the format the page names (never sniffed
// here). Each row: MuPDF's magic (the type it opens the bytes as), whether its pages are laid out by the engine
// (`reflowable`; MuPDF's isReflowable() returns nothing, so this table is the only answer), and whether MuPDF reads the
// whole file into its heap on open (`readsWhole`: the file counts against the heap budget) rather than reading it as
// it goes through the byte stream.

export type MupdfFormat = "epub" | "mobi" | "fb2"

export interface MupdfFormatRow {
	readonly magic: string
	readonly reflowable: boolean
	readonly readsWhole: boolean
}

export const MUPDF_FORMATS: Readonly<Record<MupdfFormat, MupdfFormatRow>> = {
	// A zip, its entries read through the stream as pages need them.
	epub: { magic: "application/epub+zip", reflowable: true, readsWhole: false },
	mobi: { magic: "application/x-mobipocket-ebook", reflowable: true, readsWhole: true },
	fb2: { magic: "application/x-fictionbook", reflowable: true, readsWhole: true }
}

export function isMupdfFormat(value: unknown): value is MupdfFormat {
	return typeof value === "string" && Object.hasOwn(MUPDF_FORMATS, value)
}
