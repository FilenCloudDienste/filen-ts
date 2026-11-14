import type { RefObject } from "react"
import type { PdfPagesSurfaceValue } from "@/features/pdf/pages/pagesSurfaceContext"
import { toolEnabled } from "@/features/pdf/tools/registry"
import { keyForEditor } from "@/lib/keymap/dialogGuard"
import { IN_EDITORS, useAction } from "@/lib/keymap/useAction"

// Page rotate (Mod+Alt+] / Mod+Alt+[): the pages selected in the rail or the Organise grid, or the current page, turn
// a quarter in the file, from anywhere in the viewer's layer but a field. The view's own rotate (Mod+] / Mod+[) stays
// the viewer's.
export function usePdfPageKeys(rootRef: RefObject<HTMLElement | null>, value: PdfPagesSurfaceValue | null): void {
	const rotate = (event: KeyboardEvent, degrees: 90 | -90): void => {
		const root = rootRef.current

		if (root === null || value === null || !keyForEditor(root, event.target)) return

		event.preventDefault()

		if (toolEnabled("pages", value.policy).enabled) value.controller.rotate(value.controller.targets(), degrees)
	}

	useAction(
		"pdf.rotatePagesCw",
		event => {
			rotate(event, 90)
		},
		IN_EDITORS,
		[value]
	)
	useAction(
		"pdf.rotatePagesCcw",
		event => {
			rotate(event, -90)
		},
		IN_EDITORS,
		[value]
	)
}
