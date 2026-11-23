import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"
import { FENCE_MAX_CHARS } from "@/features/preview/lib/fenceBudget"

// How a markdown document opens for editing, the file preview's and the notes editor's alike: Live preview (the
// source styled in place, livePreview.ts) or Source, and whether in Read (the rendered page) instead. One value kept
// on this device, read during boot (lib/sdk/boot.ts), so an editor's first render shows it. A file that cannot be
// edited opens in Read whatever was chosen.

export type MarkdownEditMode = "live" | "source"

export interface MarkdownViewChoice {
	readonly edit: MarkdownEditMode
	readonly read: boolean
}

const DEFAULTS: MarkdownViewChoice = { edit: "live", read: false }

// Past the document's highlighting budget (fenceBudget.ts) a document edits as Source: live preview's decorations stay
// within the viewport, but its tables and fences are read whole, and a parse of so much is not worth a frame.
export const LIVE_PREVIEW_MAX_CHARS = FENCE_MAX_CHARS

export function livePreviewFits(text: string): boolean {
	return text.length <= LIVE_PREVIEW_MAX_CHARS
}

const preference = preloadedPreference<MarkdownViewChoice>({
	key: "preview.markdownView.v1",
	schema: type({ edit: "'live' | 'source'", read: "boolean" }),
	fallback: DEFAULTS,
	scope: "preview",
	same: (a, b) => a.edit === b.edit && a.read === b.read
})

export const loadMarkdownView = preference.load

export const getMarkdownView = preference.get

export function useMarkdownView(): MarkdownViewChoice {
	return useSyncExternalStore(preference.subscribe, preference.get, preference.get)
}

export function setMarkdownView(change: Partial<MarkdownViewChoice>): void {
	preference.set({ ...preference.get(), ...change })
}
