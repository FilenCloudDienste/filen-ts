import { matchesCombo, type ChordEvent } from "@filen/shared/keymap"
import { VIDEO_EDITOR_ACTIONS, type VideoEditorAction } from "@/features/preview/lib/keymap"
import { bindingOf } from "@/lib/keymap/bindingOf"
import type { ActionDef } from "@/lib/keymap/registry"

// The keys the overlay runs (leaving the editor through its own dismissal), not the editor.
export type OverlayVideoAction = "preview.videoCancel"

export type EditorVideoAction = Exclude<VideoEditorAction, OverlayVideoAction>

function isEditorAction(id: VideoEditorAction): id is EditorVideoAction {
	return id !== "preview.videoCancel"
}

const EDITOR_ACTIONS: readonly EditorVideoAction[] = VIDEO_EDITOR_ACTIONS.map(def => def.id).filter(isEditorAction)
const DEFS: ReadonlyMap<string, ActionDef> = new Map(VIDEO_EDITOR_ACTIONS.map(def => [def.id, def]))

// Keys that repeat while held (stepping, undo, zoom); the rest act once per press.
const REPEATS: ReadonlySet<EditorVideoAction> = new Set<EditorVideoAction>([
	"preview.videoUndo",
	"preview.videoRedo",
	"preview.videoFrameBack",
	"preview.videoFrameForward",
	"preview.videoSecondBack",
	"preview.videoSecondForward",
	"preview.videoShuttleBack",
	"preview.videoZoomIn",
	"preview.videoZoomOut"
])

// The editor's action a keydown is, under `combos` (the combos in effect by id, useBindings).
export function videoEditorKey(event: ChordEvent, combos: Readonly<Record<string, string>>, mac: boolean): EditorVideoAction | undefined {
	return EDITOR_ACTIONS.find(id => {
		const def = DEFS.get(id)

		return def !== undefined && matchesCombo(event, bindingOf(combos, def, mac), mac)
	})
}

export function repeatsWhileHeld(action: EditorVideoAction): boolean {
	return REPEATS.has(action)
}

// The definition of the overlay's key, for its dismissal check (Escape leaves the editor only while it is bound).
export const VIDEO_CANCEL_ACTION: ActionDef | undefined = DEFS.get("preview.videoCancel")
