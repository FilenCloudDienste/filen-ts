import type { ObjectKeyBindings } from "@filen/office/react/presentation"
import { useBindings, type ActionDef } from "@/lib/keymap/registry"

// Object commands of the presentation editor's slide canvas that a user may rebind: select all, group, ungroup and
// the stacking order (PowerPoint's keys). The editing keys PowerPoint fixes (arrows nudge, Delete, Tab, Enter,
// Escape) are the canvas's own. The ids end in the canvas's command names (ObjectCommand), so the bindings the
// canvas matches are read from this list.
export const PRESENTATION_OBJECT_ACTIONS: readonly ActionDef[] = [
	{
		id: "presentation.objects.selectAll",
		defaultCombo: "mod+a",
		scope: "editor",
		section: "presentationObjects",
		hintKey: "settings:keyboardHintSlideShapes",
		descriptionKey: "preview:previewPptxShortcutSelectAll"
	},
	{
		id: "presentation.objects.group",
		defaultCombo: "mod+g",
		scope: "editor",
		section: "presentationObjects",
		hintKey: "settings:keyboardHintSlideShapes",
		descriptionKey: "preview:previewPptxShortcutGroup"
	},
	{
		id: "presentation.objects.ungroup",
		defaultCombo: "mod+shift+g",
		scope: "editor",
		section: "presentationObjects",
		hintKey: "settings:keyboardHintSlideShapes",
		descriptionKey: "preview:previewPptxShortcutUngroup"
	},
	{
		id: "presentation.objects.bringToFront",
		defaultCombo: "mod+shift+bracketright",
		scope: "editor",
		section: "presentationObjects",
		hintKey: "settings:keyboardHintSlideShapes",
		descriptionKey: "preview:previewPptxShortcutBringToFront"
	},
	{
		id: "presentation.objects.sendToBack",
		defaultCombo: "mod+shift+bracketleft",
		scope: "editor",
		section: "presentationObjects",
		hintKey: "settings:keyboardHintSlideShapes",
		descriptionKey: "preview:previewPptxShortcutSendToBack"
	},
	{
		id: "presentation.objects.bringForward",
		defaultCombo: "mod+bracketright",
		scope: "editor",
		section: "presentationObjects",
		hintKey: "settings:keyboardHintSlideShapes",
		descriptionKey: "preview:previewPptxShortcutBringForward"
	},
	{
		id: "presentation.objects.sendBackward",
		defaultCombo: "mod+bracketleft",
		scope: "editor",
		section: "presentationObjects",
		hintKey: "settings:keyboardHintSlideShapes",
		descriptionKey: "preview:previewPptxShortcutSendBackward"
	}
]

const PREFIX = "presentation.objects."

// The canvas's bindings from this list: each command's combo (`comboOf` resolves the combo in effect once the actions
// are registered; the default otherwise).
export function presentationObjectBindings(
	comboOf: (id: string, fallback: string) => string = (_id, fallback) => fallback
): ObjectKeyBindings {
	const bindings: Record<string, string> = {}

	for (const def of PRESENTATION_OBJECT_ACTIONS) bindings[def.id.slice(PREFIX.length)] = comboOf(def.id, def.defaultCombo)

	return bindings as unknown as ObjectKeyBindings
}

// One bindings object per keymap record: the store swaps the record only when the user edits a binding, so the
// canvas gets the same object between renders and its combo parse cache keeps hitting.
const BY_BINDINGS = new WeakMap<Readonly<Record<string, string>>, ObjectKeyBindings>()

// The bindings for the mounted canvas, following the user's changes (an action turned off is "").
export function usePresentationObjectBindings(): ObjectKeyBindings {
	const combos = useBindings()
	let bindings = BY_BINDINGS.get(combos)

	if (bindings === undefined) {
		bindings = presentationObjectBindings((id, fallback) => combos[id] ?? fallback)
		BY_BINDINGS.set(combos, bindings)
	}

	return bindings
}
