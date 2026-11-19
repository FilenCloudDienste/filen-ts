import type { DocxSessionApi } from "@filen/office/dom/docx"
import { DocxMediaCache, type DocxDocument } from "@filen/office/react/docx"

// Viewer stand-ins for DOM tests of the editor views: a session and a document that hold nothing.

// A viewer session that holds nothing (no objects, media, finds or annotations), made per call.
export function emptyDocxSession(): DocxSessionApi {
	return {
		objects: () => Promise.resolve([]),
		media: () => Promise.resolve(null),
		locate: () => Promise.resolve(null),
		find: () => Promise.resolve(new Int32Array(0)),
		annotations: () => Promise.resolve(null),
		close: () => undefined
	}
}

// A ready document of no pages over `session`, with a media cache of its own (made per call).
export function emptyDocxDocument(session: DocxSessionApi = emptyDocxSession()): DocxDocument {
	return {
		status: "ready",
		info: undefined,
		pages: [],
		pageCount: 0,
		tables: { styles: [], decorations: [], links: [] },
		session,
		media: new DocxMediaCache(session, undefined, { create: () => "blob:picture", revoke: () => undefined }),
		error: undefined
	}
}
