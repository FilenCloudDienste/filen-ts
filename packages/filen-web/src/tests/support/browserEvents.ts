import { vi } from "vitest"

type StubDocument = EventTarget & { visibilityState: DocumentVisibilityState }

// A window and document for node-environment tests of code that listens to page events: plain EventTargets,
// with the document's visibility settable. Undo with vi.unstubAllGlobals().
export function stubBrowserEvents(): { window: EventTarget; document: StubDocument } {
	const window = new EventTarget()
	const visibilityState: DocumentVisibilityState = "visible"
	const document: StubDocument = Object.assign(new EventTarget(), { visibilityState })

	vi.stubGlobal("window", window)
	vi.stubGlobal("document", document)

	return { window, document }
}
