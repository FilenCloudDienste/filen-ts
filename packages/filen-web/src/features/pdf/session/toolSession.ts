import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import { isImeKeydown } from "@filen/shared/keymap"
import { pdfToolLetterAllowed } from "@/features/pdf/lib/toolKeys"
import { toolInEffect, type PdfPolicyState, type PdfTool, type PdfToolContext } from "@/features/pdf/tools/registry"
import { pdfSurfaceKey } from "@/features/pdf/tools/toolKeys.logic"
import { isAnyOverlayOpen } from "@/lib/keymap/dialogGuard"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { isRecordingCombo } from "@/lib/keymap/registry"

// The editor session's tool glue the viewer runs: keys on the page surface, and the Save option that draws the
// annotations into the pages first.

const MAC = isMacPlatform()

// With "Flatten annotations" chosen, every annotation is drawn into its page (one undo step) before `save` writes the
// document.
export async function flattenedFirst<T>(session: PdfEditSessionModel | null, flatten: boolean, save: () => Promise<T>): Promise<T> {
	if (flatten && session !== null) await session.dispatch("annotations.flatten", {})

	return save()
}

export interface PdfSurfaceKeyDeps {
	readonly tools: readonly PdfTool[]
	readonly combos: Readonly<Record<string, string>>
	readonly activeTool: string | null
	readonly policy: PdfPolicyState
	readonly context: PdfToolContext
	readonly activate: (tool: string | null) => void
}

// A keydown or keyup on the viewer: a tool letter picks its tool (an action tool runs), and Enter, Escape, Delete, the
// arrows and Space go to the tool in effect. Only keys pressed on the page surface outside its fields, never while a
// dialog or menu is open, an input method composes or a shortcut is being recorded. True when a tool took the key.
export function pdfToolSurfaceKey(event: KeyboardEvent, surface: Element, page: number, deps: PdfSurfaceKeyDeps): boolean {
	if (event.defaultPrevented || isImeKeydown(event) || isRecordingCombo() || isAnyOverlayOpen()) return false
	if (!pdfToolLetterAllowed(event.target, surface)) return false

	const key = pdfSurfaceKey(event, deps.tools, deps.combos, MAC)

	if (key === null) return false

	const up = event.type === "keyup"

	if (key.kind === "tool") {
		if (up || event.repeat) return true

		const tool = key.tool

		if (!tool.enabledWhen(deps.policy).enabled) return true

		if (tool.run !== undefined) tool.run(deps.context)
		else deps.activate(tool.id)

		return true
	}

	// A held key repeats: Space stays held, an arrow nudges again.
	if (key.key !== "Space" && up) return false
	if (key.key === "Space" && event.repeat) return deps.activeTool !== null

	const tool = toolInEffect(deps.tools, deps.activeTool)

	return tool?.onKey?.({ kind: up ? "up" : "down", key: key.key, shift: event.shiftKey, alt: event.altKey, page }, deps.context) ?? false
}
