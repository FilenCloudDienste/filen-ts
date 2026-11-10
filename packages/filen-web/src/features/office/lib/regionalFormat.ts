import { useSyncExternalStore } from "react"
import { browserLanguage } from "@/features/spreadsheet/formulaBar/sheetLocale"
import { createListenerSet } from "@/lib/listenerSet"

// The language spreadsheets type and show numbers and dates in: the user's regional format (Settings, Office), else
// the browser's. Held here, set by the office settings store as its file is read (officeSettings.ts), so the
// spreadsheet code reads it without importing that store.

let chosen: string | null = null
let loader: (() => Promise<void>) | null = null
const listeners = createListenerSet("office")

export function setRegionalFormat(tag: string | null): void {
	if (tag !== chosen) {
		chosen = tag
		listeners.emit()
	}
}

// How the settings are read before a file opens in the regional format (the office settings store's load).
export function setRegionalFormatLoader(load: () => Promise<void>): void {
	loader = load
}

export function regionalLanguage(): string {
	return chosen ?? browserLanguage()
}

// The regional language once the settings were read (the first read; later ones change it in place).
export async function loadedRegionalLanguage(): Promise<string> {
	await loader?.()

	return regionalLanguage()
}

function subscribe(listener: () => void): () => void {
	return listeners.subscribe(listener)
}

export function useRegionalLanguage(): string {
	return useSyncExternalStore(subscribe, regionalLanguage, regionalLanguage)
}
