import { matchesCombo, type ChordEvent } from "@filen/shared/keymap"
import { PDF_EDITOR_FIXED_ACTIONS } from "@/features/pdf/lib/keymap"
import type { PdfTool, PdfToolKeyEvent } from "@/features/pdf/tools/registry"

// What a key on the page surface is to the editor's tools (outside fields; the host checks pdfToolLetterAllowed): a
// tool's letter (V, H, T, D, U, C, …, as bound), or a key the tool in effect may take (Enter, Escape and Delete as
// pdf.escape and pdf.delete are bound, the arrows, Space).

export type PdfSurfaceKey =
	{ readonly kind: "tool"; readonly tool: PdfTool } | { readonly kind: "key"; readonly key: PdfToolKeyEvent["key"] }

type Arrow = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"

function isArrow(key: string): key is Arrow {
	return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown"
}

function fixedCombo(id: "pdf.delete" | "pdf.escape", combos: Readonly<Record<string, string>>): string {
	return combos[id] ?? PDF_EDITOR_FIXED_ACTIONS.find(def => def.id === id)?.defaultCombo ?? ""
}

export function pdfSurfaceKey(
	event: ChordEvent & { readonly key: string; readonly code: string; readonly metaKey: boolean; readonly ctrlKey: boolean },
	tools: readonly PdfTool[],
	combos: Readonly<Record<string, string>>,
	mac: boolean
): PdfSurfaceKey | null {
	for (const tool of tools) {
		for (const def of tool.actions) if (matchesCombo(event, combos[def.id] ?? def.defaultCombo, mac)) return { kind: "tool", tool }
	}

	if (matchesCombo(event, fixedCombo("pdf.escape", combos), mac)) return { kind: "key", key: "Escape" }
	if (matchesCombo(event, fixedCombo("pdf.delete", combos), mac)) return { kind: "key", key: "Delete" }
	if (event.metaKey || event.ctrlKey) return null
	if (event.key === "Enter") return { kind: "key", key: "Enter" }
	if (isArrow(event.key)) return { kind: "key", key: event.key }
	if (event.code === "Space") return { kind: "key", key: "Space" }

	return null
}
