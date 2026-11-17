import type { MupdfLayout, PdfReadMetadata } from "@filen/office/dom/pdfedit"
import type { MetadataField, MetadataSectionData } from "@/features/preview/lib/metadataCard.types"

// An e-book's page geometry: the pages area's size at 100 % zoom in points, less a gutter each side, clamped and
// quantized, so small changes of the area never lay the book out again. The text size is the reader's own control
// (the viewer's zoom stays pure magnification). A new size counts only when the width moved by a step or the height by
// a fifth: the find bar, an on-screen keyboard or a mobile URL bar never cost a whole-book layout.

// CSS pixels to points.
const PT_PER_PX = 72 / 96
const GUTTER_PX = 24
const STEP_PT = 16
const WIDTH_PT: readonly [number, number] = [280, 720]
const HEIGHT_PT: readonly [number, number] = [360, 1080]
const HEIGHT_CHANGE = 0.2

// The text sizes offered, in points, and the default.
export const EBOOK_TEXT_SIZES = [9, 10, 11, 12, 14, 16, 18] as const
export const EBOOK_DEFAULT_TEXT_SIZE = 11

// Waits before a counted change lays the book out: a resize burst, then a text-size burst.
export const EBOOK_RESIZE_DEBOUNCE_MS = 400
export const EBOOK_TEXT_SIZE_DEBOUNCE_MS = 300

function fit(px: number, [min, max]: readonly [number, number]): number {
	const pt = Math.max(0, px - 2 * GUTTER_PX) * PT_PER_PX

	return Math.min(max, Math.max(min, Math.round(pt / STEP_PT) * STEP_PT))
}

// The page size for a pages area of `width` × `height` CSS pixels.
export function ebookPageSize(width: number, height: number): { readonly width: number; readonly height: number } {
	return { width: fit(width, WIDTH_PT), height: fit(height, HEIGHT_PT) }
}

// Whether a new page size is worth a layout over the one laid out.
export function ebookSizeCounts(
	laid: { readonly width: number; readonly height: number },
	next: { readonly width: number; readonly height: number }
): boolean {
	return Math.abs(next.width - laid.width) >= STEP_PT || Math.abs(next.height - laid.height) >= laid.height * HEIGHT_CHANGE
}

export function ebookLayout(size: { readonly width: number; readonly height: number }, em: number): MupdfLayout {
	return { width: size.width, height: size.height, em }
}

// The next text size a step down (-1) or up (+1) from `em`; the same at either end.
export function ebookTextStep(em: number, direction: -1 | 1): number {
	const index = EBOOK_TEXT_SIZES.findIndex(size => size >= em)
	const at = index === -1 ? EBOOK_TEXT_SIZES.length - 1 : index

	return EBOOK_TEXT_SIZES[Math.min(EBOOK_TEXT_SIZES.length - 1, Math.max(0, at + direction))] ?? em
}

// MuPDF's format names to the reader's.
const FORMAT_NAMES: Readonly<Record<string, string>> = { EPUB: "EPUB", MOBI: "MOBI", FictionBook2: "FictionBook (FB2)" }

export interface EbookPropertyLabels {
	readonly title: string
	readonly author: string
	readonly subject: string
	readonly format: string
	readonly pages: string
}

// The book's properties as MetadataCard data: what it says about itself, its format and its pages at this layout.
export function ebookMetadataSections(metadata: PdfReadMetadata, pageCount: number, labels: EbookPropertyLabels): MetadataSectionData[] {
	const fields: MetadataField[] = []
	const add = (label: string, value: string | null): void => {
		if (value !== null && value.length > 0) fields.push({ label, value })
	}

	add(labels.title, metadata.title)
	add(labels.author, metadata.author)
	add(labels.subject, metadata.subject)
	add(labels.format, FORMAT_NAMES[metadata.format] ?? metadata.format)
	add(labels.pages, String(pageCount))

	return [{ fields }]
}
