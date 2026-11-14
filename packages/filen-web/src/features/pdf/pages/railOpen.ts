import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"

// Whether the PDF pages rail is shown beside the pages: one boolean kept on this device, closed until the user opens
// it (every thumbnail is a page the viewer reads and decodes), read during boot (lib/sdk/boot.ts) so a PDF opens with
// the rail as it was left.

const preference = preloadedPreference({
	key: "preview.pdf.pagesRail.v1",
	schema: type("boolean"),
	fallback: false,
	scope: "preview",
	same: (a, b) => a === b
})

export const loadPdfPagesRailOpen = preference.load

export function usePdfPagesRailOpen(): boolean {
	return useSyncExternalStore(preference.subscribe, preference.get, preference.get)
}

export function togglePdfPagesRail(): void {
	preference.set(!preference.get())
}
