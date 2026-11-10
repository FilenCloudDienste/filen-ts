import type { ShowKeyBindings, ShowKeyCommand } from "@filen/office/react/presentation"
import { useBindings, type ActionDef } from "@/lib/keymap/registry"

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

// The running show keeps its letter keys with single-key shortcuts off: they are a clicker's and PowerPoint's, and act
// only on the show's own stage. Starting the show is the editor's.
export const PRESENTATION_SHOW_ACTIONS: readonly (ActionDef & { readonly id: PresentationShowAction })[] = COMMANDS.map(command => ({
	id: actionId(command),
	defaultCombo: DEFAULTS[command].combo,
	scope: "editor",
	section: "slideshow",
	descriptionKey: DEFAULTS[command].description,
	hintKey:
		command === "start" || command === "startCurrent" ? "settings:keyboardHintPresentationEditor" : "settings:keyboardHintSlideshow",
	keepsCharacterKeys: true
}))

// The show's keys from the combos in effect by action id (each action's default where one is missing).
export function presentationShowBindings(combos: Readonly<Record<string, string>>): ShowKeyBindings {
	const bindings: Partial<Record<ShowKeyCommand, string>> = {}

	for (const command of COMMANDS) bindings[command] = combos[actionId(command)] ?? DEFAULTS[command].combo

	return bindings as ShowKeyBindings
}

// The bindings for the running show, following the user's changes as they make them.
export function usePresentationShowBindings(): ShowKeyBindings {
	return presentationShowBindings(useBindings())
}
