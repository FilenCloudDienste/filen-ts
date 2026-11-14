import { useSyncExternalStore } from "react"
import type { PdfEditSessionModel, PdfEditSnapshot } from "./session"

// The session's snapshot for a view: re-rendered on every change, undo, redo, save and widget read. Null while there is
// no session (the viewer still shows pdf.js).
export function usePdfEditSession(session: PdfEditSessionModel | null): PdfEditSnapshot | null {
	return useSyncExternalStore(session?.subscribe ?? subscribeNone, () => session?.getSnapshot() ?? null)
}

function subscribeNone(): () => void {
	return () => undefined
}
