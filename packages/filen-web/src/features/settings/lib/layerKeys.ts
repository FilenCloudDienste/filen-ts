import type { Options } from "react-hotkeys-hook"
import { isOverlayOpenBesides, keyForEditor } from "@/lib/keymap/dialogGuard"
import { shouldIgnoreEvent } from "@/lib/keymap/useAction"

// Whether a key belongs to the surface at `root`: pressed in it or elsewhere in the layer it is shown in (the page, or
// the dialog holding it), never in a native field outside it, and never with another dialog or menu over it.
export function keyInLayerOf(root: Element | null, target: EventTarget | null): boolean {
	return root !== null && keyForEditor(root, target) && !isOverlayOpenBesides(root)
}

// The `ignoreEventWhen` of an action of one surface that may be a page or sit in a dialog (the shortcuts list is
// both): it fires in that surface's own layer only. Read the root from a ref inside the callback, at the key press.
export function ignoredOutsideLayer(event: KeyboardEvent, root: Element | null): boolean {
	return shouldIgnoreEvent(event) || !keyInLayerOf(root, event.target)
}

// The form tags such an action also fires from: a search box's own key, which would otherwise open the browser's find.
export const LAYER_FIELD_TAGS: NonNullable<Options["enableOnFormTags"]> = ["option", "input", "textarea"]
