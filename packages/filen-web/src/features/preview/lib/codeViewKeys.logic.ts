import { matchesCombo, type ChordEvent } from "@filen/shared/keymap"
import { CODE_EDITOR_ACTIONS } from "@/features/preview/lib/keymap"
import { browserZoomKey, zoomKeyAction, type BrowserZoomKey } from "@/lib/keymap/browserZoom"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { CODE_DEFAULT_FONT_SIZE, CODE_FONT_SIZES, type CodeViewSettings } from "@/features/preview/lib/codeViewSettings"
import type { ActionDef } from "@/lib/keymap/registry"

// The text and code viewers' view keys, matched on their surface (codeSurface.tsx) wherever focus is in its layer:
// the editor's keys reach the surface as CodeMirror leaves them, and these act on the view, not the text.
export type CodeViewAction =
	| "editor.toggleWordWrap"
	| "editor.toggleLineNumbers"
	| "editor.fontSizeIncrease"
	| "editor.fontSizeDecrease"
	| "editor.fontSizeReset"
	| "editor.viewChanges"

const IDS: ReadonlySet<string> = new Set<CodeViewAction>([
	"editor.toggleWordWrap",
	"editor.toggleLineNumbers",
	"editor.fontSizeIncrease",
	"editor.fontSizeDecrease",
	"editor.fontSizeReset",
	"editor.viewChanges"
])

function isCodeViewAction(def: ActionDef): def is ActionDef & { readonly id: CodeViewAction } {
	return IDS.has(def.id)
}

const CODE_VIEW_ACTIONS: readonly (ActionDef & { readonly id: CodeViewAction })[] = CODE_EDITOR_ACTIONS.filter(isCodeViewAction)

const ZOOM_ACTIONS: Readonly<Record<BrowserZoomKey, CodeViewAction>> = {
	in: "editor.fontSizeIncrease",
	out: "editor.fontSizeDecrease",
	reset: "editor.fontSizeReset"
}

// The view action a keydown is under `combos` (the combos in effect by id, useBindings). The browser's zoom keys, read by
// character, size the text ahead of the default bindings, as the PDF viewer zooms (browserZoom.ts).
export function codeViewKey(
	event: ChordEvent,
	combos: Readonly<Record<string, string>>,
	mac: boolean = isMacPlatform()
): CodeViewAction | undefined {
	const zoom = browserZoomKey(event, mac)

	if (zoom !== undefined) {
		return zoomKeyAction(event, CODE_VIEW_ACTIONS, ZOOM_ACTIONS[zoom], combos, mac)
	}

	return CODE_VIEW_ACTIONS.find(def => matchesCombo(event, combos[def.id] ?? def.defaultCombo, mac))?.id
}

// The next font size up or down the menu's steps from `size`, the same size at an end.
export function stepFontSize(size: number, direction: 1 | -1): number {
	if (direction > 0) {
		return CODE_FONT_SIZES.find(step => step > size) ?? size
	}

	let smaller = size

	for (const step of CODE_FONT_SIZES) {
		if (step < size) {
			smaller = step
		}
	}

	return smaller
}

// The settings a view action sets, or null for one that is not a setting (View changes).
export function codeViewSettingsChange(action: CodeViewAction, settings: CodeViewSettings): Partial<CodeViewSettings> | null {
	switch (action) {
		case "editor.toggleWordWrap":
			return { wrap: !settings.wrap }
		case "editor.toggleLineNumbers":
			return { lineNumbers: !settings.lineNumbers }
		case "editor.fontSizeIncrease":
			return { fontSize: stepFontSize(settings.fontSize, 1) }
		case "editor.fontSizeDecrease":
			return { fontSize: stepFontSize(settings.fontSize, -1) }
		case "editor.fontSizeReset":
			return { fontSize: CODE_DEFAULT_FONT_SIZE }
		case "editor.viewChanges":
			return null
	}
}
