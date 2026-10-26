import type { ReactNode } from "react"

// What the presentation File menu's entry files are given (the menu, presentationFileMenu.tsx, lists them in order).
export interface PresentationFileMenuContext {
	readonly editable: boolean
	// Downloads are allowed (not a downloads-disabled link).
	readonly downloads: boolean
	readonly close: () => void
}

export interface PresentationFileMenuEntryProps {
	readonly context: PresentationFileMenuContext
}

// Save, the autosave state and Download. None yet.
export function PresentationSaveEntries(_props: PresentationFileMenuEntryProps): ReactNode {
	return null
}
