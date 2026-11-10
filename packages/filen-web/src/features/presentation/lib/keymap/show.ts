import type { ShowKeyBindings, ShowKeyCommand } from "@filen/office/react/presentation"
import { useOverrides, type ActionDef } from "@/lib/keymap/registry"

// The slideshow's keys a user may rebind, PowerPoint's (and a presentation clicker's: PageDown, PageUp, B, F5,
// Escape). The show takes them while it runs, on the audience stage and in the presenter view, and stops each one
// there, so the listings under the preview (drive's N, Escape and Mod+A, photos' and the editor's own) never see
// them: focus decides, which lib/keymap/conflicts.ts lists once these actions are registered. F5 and Shift+F5 start
// the show from the editor. A slide number typed and then Enter is fixed, as in PowerPoint.
export type PresentationShowAction = `presentation.show.${ShowKeyCommand}`

// PowerPoint's keys; the show's own defaults (DEFAULT_SHOW_BINDINGS) are the same, and a test holds them together.
// Data only: lib/keymap/actions.ts registers this list without loading the office package.
const DEFAULTS: Readonly<Record<ShowKeyCommand, { readonly combo: string; readonly description: ActionDef["descriptionKey"] }>> = {
	next: { combo: "arrowright,arrowdown,pagedown,space,enter,n", description: "preview:previewPptxShortcutShowNext" },
	previous: { combo: "arrowleft,arrowup,pageup,backspace,p", description: "preview:previewPptxShortcutShowPrevious" },
	first: { combo: "home", description: "preview:previewPptxShortcutShowFirst" },
	last: { combo: "end", description: "preview:previewPptxShortcutShowLast" },
	nextHidden: { combo: "h", description: "preview:previewPptxShortcutShowNextHidden" },
	black: { combo: "b,period", description: "preview:previewPptxShortcutShowBlack" },
	white: { combo: "w,comma", description: "preview:previewPptxShortcutShowWhite" },
	end: { combo: "escape", description: "preview:previewPptxShortcutShowEnd" },
	laser: { combo: "mod+l", description: "preview:previewPptxShortcutShowLaser" },
	pen: { combo: "mod+p", description: "preview:previewPptxShortcutShowPen" },
	eraser: { combo: "mod+e", description: "preview:previewPptxShortcutShowEraser" },
	arrow: { combo: "mod+a", description: "preview:previewPptxShortcutShowArrow" },
	hidePointer: { combo: "ctrl+h", description: "preview:previewPptxShortcutShowHidePointer" },
	togglePointer: { combo: "a,equal", description: "preview:previewPptxShortcutShowTogglePointer" },
	eraseAll: { combo: "e", description: "preview:previewPptxShortcutShowEraseAll" },
	start: { combo: "f5", description: "preview:previewPptxShortcutShowStart" },
	startCurrent: { combo: "shift+f5", description: "preview:previewPptxShortcutShowStartCurrent" }
}

const COMMANDS = Object.keys(DEFAULTS) as ShowKeyCommand[]

function actionId(command: ShowKeyCommand): PresentationShowAction {
	return `presentation.show.${command as string}` as PresentationShowAction
}

export const PRESENTATION_SHOW_ACTIONS: readonly (ActionDef & { readonly id: PresentationShowAction })[] = COMMANDS.map(command => ({
	id: actionId(command),
	defaultCombo: DEFAULTS[command].combo,
	scope: "editor",
	descriptionKey: DEFAULTS[command].description
}))

// The show's keys with the user's overrides applied (each action's default otherwise).
export function presentationShowBindings(overrides: Readonly<Record<string, string>>): ShowKeyBindings {
	const bindings: Partial<Record<ShowKeyCommand, string>> = {}

	for (const command of COMMANDS) bindings[command] = overrides[actionId(command)] ?? DEFAULTS[command].combo

	return bindings as ShowKeyBindings
}

// The bindings for the running show, following overrides as the user changes them.
export function usePresentationShowBindings(): ShowKeyBindings {
	return presentationShowBindings(useOverrides())
}
