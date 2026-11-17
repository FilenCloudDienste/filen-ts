import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"

// The outline's place beside the pages, kept on this device and read during boot (lib/sdk/boot.ts): whether the
// viewer's outline pane is open (closed until the user opens it), and which tab the editor's left rail shows.

const paneOpen = preloadedPreference({
	key: "preview.pdf.outlinePane.v1",
	schema: type("boolean"),
	fallback: false,
	scope: "preview",
	same: (a, b) => a === b
})

export type PdfRailTab = "pages" | "outline"

const railTab = preloadedPreference<PdfRailTab>({
	key: "preview.pdf.railTab.v1",
	schema: type("'pages' | 'outline'"),
	fallback: "pages",
	scope: "preview",
	same: (a, b) => a === b
})

export async function loadPdfOutlinePreferences(): Promise<void> {
	await Promise.all([paneOpen.load(), railTab.load()])
}

export function usePdfOutlinePaneOpen(): boolean {
	return useSyncExternalStore(paneOpen.subscribe, paneOpen.get, paneOpen.get)
}

export function togglePdfOutlinePane(): void {
	paneOpen.set(!paneOpen.get())
}

export function closePdfOutlinePane(): void {
	paneOpen.set(false)
}

export function usePdfRailTab(): PdfRailTab {
	return useSyncExternalStore(railTab.subscribe, railTab.get, railTab.get)
}

export function setPdfRailTab(tab: PdfRailTab): void {
	railTab.set(tab)
}
