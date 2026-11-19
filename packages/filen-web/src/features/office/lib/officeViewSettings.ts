import { useSyncExternalStore } from "react"
import { type } from "arktype"
import type { DocxAutoFormat } from "@filen/office/core/docx/edit"
import type { DocxMarkupMode } from "@filen/office/dom/docx"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"

// How the office editors open on this device (Settings, Office): the markup a Word document shows, whether it opens
// as pages or reflowed (Mobile view), whether a presentation opens with its slide thumbnails and notes, and which
// of Word's AutoFormat As You Type a Word document is edited with (curly quotes, automatic lists). Kept on
// the device (the right view depends on its screen), read during boot (lib/sdk/boot.ts), so an editor's first render
// opens with it.

export type DocxOpenView = "auto" | "pages" | "reflow"

export interface OfficeViewSettings {
	readonly markup: DocxMarkupMode
	readonly docxView: DocxOpenView
	readonly slideRail: boolean
	readonly notesPane: boolean
	// Absent in a choice stored before they existed: on, as in Word.
	readonly autoQuotes?: boolean
	readonly autoLists?: boolean
}

export const DEFAULT_OFFICE_VIEW_SETTINGS: OfficeViewSettings = {
	markup: "simple",
	docxView: "auto",
	slideRail: true,
	notesPane: true,
	autoQuotes: true,
	autoLists: true
}

const preference = preloadedPreference<OfficeViewSettings>({
	key: "office.viewSettings.v1",
	schema: type({
		markup: "'all' | 'simple' | 'none' | 'original'",
		docxView: "'auto' | 'pages' | 'reflow'",
		slideRail: "boolean",
		notesPane: "boolean",
		"autoQuotes?": "boolean",
		"autoLists?": "boolean"
	}),
	fallback: DEFAULT_OFFICE_VIEW_SETTINGS,
	scope: "office",
	same: (a, b) =>
		a.markup === b.markup &&
		a.docxView === b.docxView &&
		a.slideRail === b.slideRail &&
		a.notesPane === b.notesPane &&
		(a.autoQuotes ?? true) === (b.autoQuotes ?? true) &&
		(a.autoLists ?? true) === (b.autoLists ?? true)
})

export const loadOfficeViewSettings = preference.load

// What an editor opens with: the value as held now.
export const officeViewSettings = preference.get

export function useOfficeViewSettings(): OfficeViewSettings {
	return useSyncExternalStore(preference.subscribe, preference.get, preference.get)
}

export function setOfficeViewSettings(change: Partial<OfficeViewSettings>): void {
	preference.set({ ...preference.get(), ...change })
}

// The AutoFormat As You Type a Word document opens with.
export function docxAutoFormat(settings: OfficeViewSettings = preference.get()): DocxAutoFormat {
	return { quotes: settings.autoQuotes ?? true, lists: settings.autoLists ?? true }
}
