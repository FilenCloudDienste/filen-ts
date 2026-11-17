import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"
import { EBOOK_DEFAULT_TEXT_SIZE, EBOOK_TEXT_SIZES } from "@/features/preview/lib/ebookLayout.logic"

// The e-book reader's text size (points), kept on this device and read during boot (lib/sdk/boot.ts): the next book
// opens at the size the last one was read at.

const SIZES = new Set<number>(EBOOK_TEXT_SIZES)

const preference = preloadedPreference({
	key: "preview.ebook.textSize.v1",
	schema: type("number").narrow(size => SIZES.has(size)),
	fallback: EBOOK_DEFAULT_TEXT_SIZE,
	scope: "preview",
	same: (a, b) => a === b
})

export const loadEbookTextSize = preference.load

export function useEbookTextSize(): number {
	return useSyncExternalStore(preference.subscribe, preference.get, preference.get)
}

export function setEbookTextSize(size: number): void {
	if (SIZES.has(size)) preference.set(size)
}
