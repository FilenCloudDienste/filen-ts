import { create } from "zustand"
import type { TextEditorEvents } from "@/components/textEditor"

export type TextEditorStore = {
	ready: boolean
	setReady: (fn: boolean | ((prev: boolean) => boolean)) => void
	/**
	 * Stable dispatch wrapper installed by the live `<TextEditor>`. The route's
	 * header reads it to render the rich-text toolbar inside the navigation bar
	 * while the keyboard is open.
	 *
	 * `null` until the editor signals ready, and reset to `null` on `<TextEditor>`
	 * unmount so a stale closure can't be invoked after the editor is gone —
	 * callers MUST null-check before dispatching.
	 */
	dispatch: ((event: TextEditorEvents) => void) | null
	setDispatch: (fn: ((event: TextEditorEvents) => void) | null) => void
}

export const useTextEditorStore = create<TextEditorStore>(set => ({
	ready: false,
	setReady(fn) {
		set(state => ({
			ready: typeof fn === "function" ? fn(state.ready) : fn
		}))
	},
	dispatch: null,
	setDispatch(fn) {
		set({
			dispatch: fn
		})
	}
}))

export default useTextEditorStore
