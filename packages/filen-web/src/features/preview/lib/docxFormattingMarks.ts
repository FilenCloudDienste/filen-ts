import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"

// Whether the Word document editor shows formatting marks (Word's Show/Hide ¶, Ctrl+Shift+8): one boolean kept on
// this device for every document, as Word keeps it, read during boot (lib/sdk/boot.ts) so a document opens with it.
// Never in the file.

const preference = preloadedPreference({
	key: "preview.docxFormattingMarks.v1",
	schema: type("boolean"),
	fallback: false,
	scope: "preview",
	same: (a, b) => a === b
})

export const loadDocxFormattingMarks = preference.load

export function useDocxFormattingMarks(): boolean {
	return useSyncExternalStore(preference.subscribe, preference.get, preference.get)
}

export const setDocxFormattingMarks = preference.set
