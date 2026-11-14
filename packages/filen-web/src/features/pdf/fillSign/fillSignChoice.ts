import { useSyncExternalStore } from "react"
import type { PdfSignatureRole, PdfVisualSignature } from "@filen/office/core/pdfedit/visualSignature"

// The signature or initials chosen in the signature dialog and waiting to be placed on a page: set by the Sign tool's
// panel, read by its page overlays, dropped once placed or when the tool ends. One preview shows at a time.

export interface FillSignChoice {
	readonly role: PdfSignatureRole
	readonly signature: PdfVisualSignature
}

let chosen: FillSignChoice | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}

// The choice now.
export function fillSignChoice(): FillSignChoice | null {
	return chosen
}

export function setFillSignChoice(next: FillSignChoice | null): void {
	if (chosen === next) return

	chosen = next

	for (const listener of listeners) listener()
}

export function useFillSignChoice(): FillSignChoice | null {
	return useSyncExternalStore(subscribe, fillSignChoice, fillSignChoice)
}
