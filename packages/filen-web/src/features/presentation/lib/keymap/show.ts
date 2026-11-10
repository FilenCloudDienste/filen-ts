import type { ShowKeyBindings, ShowKeyCommand } from "@filen/office/react/presentation"
import { CURRENT_PLATFORM, defaultComboOn, useBindings, type ActionDef, type PlatformDefault } from "@/lib/keymap/registry"

// The slideshow's keys a user may rebind, PowerPoint's (and a presentation clicker's: PageDown, PageUp, B, F5,
// Escape). The show takes them while it runs, on the audience stage and in the presenter view, and stops each one
// there, so the listings under the preview (drive's N, Escape and Mod+A, photos' and the editor's own) never see
// them: focus decides, which lib/keymap/conflicts.ts lists once these actions are registered. F5 and Shift+F5 start
// the show from the editor, Alt+F5 the presenter view; on a Mac also Cmd+Shift+Return, Cmd+Return and Option+Return
// (PowerPoint for Mac's; F5 stays for a clicker). A slide number typed and then Enter is fixed, as in PowerPoint.
export type PresentationShowAction = `presentation.show.${ShowKeyCommand}`

const ON_MAC = { mac: true } as const

// PowerPoint's keys; the show's own defaults (DEFAULT_SHOW_BINDINGS) are the same off a Mac, and a test holds them
// together. Data only: lib/keymap/actions.ts registers this list without loading the office package.
const DEFAULTS: Readonly<
	Record<ShowKeyCommand, { readonly combo: string; readonly mac?: string; readonly description: ActionDef["descriptionKey"] }>
> = {
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
	start: { combo: "f5", mac: "f5,mod+shift+enter", description: "preview:previewPptxShortcutShowStart" },
	startCurrent: { combo: "shift+f5", mac: "shift+f5,mod+enter", description: "preview:previewPptxShortcutShowStartCurrent" },
	highlighter: { combo: "mod+i", description: "preview:previewPptxShortcutShowHighlighter" },
	presenterView: { combo: "alt+f5", mac: "alt+f5,alt+enter", description: "preview:previewPptxShortcutShowPresenterView" }
}

const COMMANDS = Object.keys(DEFAULTS) as ShowKeyCommand[]

// The editor's: they start the show (or the presenter view) rather than act in it.
const STARTS: ReadonlySet<ShowKeyCommand> = new Set(["start", "startCurrent", "presenterView"])

function actionId(command: ShowKeyCommand): PresentationShowAction {
	return `presentation.show.${command as string}` as PresentationShowAction
}

function platformDefaults(command: ShowKeyCommand): { platformDefaults?: readonly PlatformDefault[] } {
	const mac = DEFAULTS[command].mac

	return mac === undefined ? {} : { platformDefaults: [{ on: ON_MAC, combo: mac }] }
}

// The running show keeps its letter keys with single-key shortcuts off: they are a clicker's and PowerPoint's, and act
// only on the show's own stage. Starting the show is the editor's.
export const PRESENTATION_SHOW_ACTIONS: readonly (ActionDef & { readonly id: PresentationShowAction })[] = COMMANDS.map(command => ({
	id: actionId(command),
	defaultCombo: DEFAULTS[command].combo,
	...platformDefaults(command),
	scope: "editor",
	section: "slideshow",
	descriptionKey: DEFAULTS[command].description,
	hintKey: STARTS.has(command) ? "settings:keyboardHintPresentationEditor" : "settings:keyboardHintSlideshow",
	keepsCharacterKeys: true
}))

const DEFINITIONS: ReadonlyMap<string, ActionDef> = new Map(PRESENTATION_SHOW_ACTIONS.map(def => [def.id, def] as const))

// The show's keys from the combos in effect by action id (each action's default on this platform where one is
// missing).
export function presentationShowBindings(combos: Readonly<Record<string, string>>): ShowKeyBindings {
	const bindings: Partial<Record<ShowKeyCommand, string>> = {}

	for (const command of COMMANDS) {
		const id = actionId(command)
		const def = DEFINITIONS.get(id)

		bindings[command] = combos[id] ?? (def === undefined ? DEFAULTS[command].combo : defaultComboOn(def, CURRENT_PLATFORM))
	}

	return bindings as ShowKeyBindings
}

// One bindings object per keymap record: the store swaps the record only when the user edits a binding, so the show
// gets the same object between renders and its combo parse cache keeps hitting.
const BY_BINDINGS = new WeakMap<Readonly<Record<string, string>>, ShowKeyBindings>()

// The bindings for the running show, following the user's changes as they make them.
export function usePresentationShowBindings(): ShowKeyBindings {
	const combos = useBindings()
	let bindings = BY_BINDINGS.get(combos)

	if (bindings === undefined) {
		bindings = presentationShowBindings(combos)
		BY_BINDINGS.set(combos, bindings)
	}

	return bindings
}
