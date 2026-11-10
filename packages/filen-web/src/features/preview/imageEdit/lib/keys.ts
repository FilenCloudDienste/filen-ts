import { matchesCombo, type ChordEvent } from "@filen/shared/keymap"
import { IMAGE_EDITOR_ACTIONS, type ImageEditorAction } from "@/features/preview/lib/keymap"
import { bindingOf } from "@/lib/keymap/bindingOf"
import type { ActionDef } from "@/lib/keymap/registry"

// The keys the overlay runs (its header's save as copy and cancel), not the editor.
export type OverlayImageAction = "preview.imageSaveCopy" | "preview.imageCancel"

export type EditorImageAction = Exclude<ImageEditorAction, OverlayImageAction>

const OVERLAY: ReadonlySet<ImageEditorAction> = new Set<ImageEditorAction>(["preview.imageSaveCopy", "preview.imageCancel"])

function isEditorAction(id: ImageEditorAction): id is EditorImageAction {
	return !OVERLAY.has(id)
}

const EDITOR_ACTIONS: readonly EditorImageAction[] = IMAGE_EDITOR_ACTIONS.map(def => def.id).filter(isEditorAction)
const OVERLAY_ACTIONS: readonly OverlayImageAction[] = ["preview.imageSaveCopy", "preview.imageCancel"]
const DEFS: ReadonlyMap<string, ActionDef> = new Map(IMAGE_EDITOR_ACTIONS.map(def => [def.id, def]))

function find<Id extends ImageEditorAction>(
	ids: readonly Id[],
	event: ChordEvent,
	combos: Readonly<Record<string, string>>,
	mac: boolean
): Id | undefined {
	return ids.find(id => {
		const def = DEFS.get(id)

		return def !== undefined && matchesCombo(event, bindingOf(combos, def, mac), mac)
	})
}

// The editor's action a keydown is, under `combos` (the combos in effect by id, useBindings).
export function imageEditorKey(event: ChordEvent, combos: Readonly<Record<string, string>>, mac: boolean): EditorImageAction | undefined {
	return find(EDITOR_ACTIONS, event, combos, mac)
}

// The overlay's image editing action a keydown is (save as copy, leave).
export function imageOverlayKey(event: ChordEvent, combos: Readonly<Record<string, string>>, mac: boolean): OverlayImageAction | undefined {
	return find(OVERLAY_ACTIONS, event, combos, mac)
}
