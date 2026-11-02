import { useEffect, type RefObject } from "react"
import { keyForEditor } from "@/lib/keymap/dialogGuard"
import { useLatestRef } from "@/lib/useLatestRef"

// An editor's own keys (its panes' F6, its shortcuts) for a key pressed outside it but in its layer: focus on the
// preview overlay itself (where Safari and macOS Firefox leave it after a click) or on the overlay's own buttons. A key
// pressed in the editor reaches its own handlers and is not passed here; one in a native field outside the editor, or
// in a dialog over it, is the field's or the dialog's (keyForEditor).
export function useEditorLayerKeys(root: RefObject<HTMLElement | null>, onKey: (event: KeyboardEvent, root: HTMLElement) => void): void {
	const latest = useLatestRef(onKey)

	useEffect(() => {
		const listener = (event: KeyboardEvent): void => {
			const element = root.current

			if (element === null || event.defaultPrevented) {
				return
			}

			if (event.target instanceof Node && element.contains(event.target)) {
				return
			}

			if (keyForEditor(element, event.target)) {
				latest.current(event, element)
			}
		}

		document.addEventListener("keydown", listener)

		return () => {
			document.removeEventListener("keydown", listener)
		}
	}, [root, latest])
}
