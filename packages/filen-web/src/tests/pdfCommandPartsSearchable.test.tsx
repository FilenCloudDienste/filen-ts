// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import type { PdfViewerState } from "@filen/office/dom/pdf"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { usePdfCommandParts } from "@/features/preview/components/pdfCommandParts"
import "@/lib/i18n"
import { PDF_SCROLL_ROOM_ANY } from "@/features/preview/lib/pdfScrollRoom.logic"

// A document without text (an image's pages) has no Find in the reader's bar.

const STATE: PdfViewerState = {
	page: 1,
	pageCount: 3,
	scale: 1.5,
	zoom: 100,
	zoomMode: "custom",
	rotation: 0,
	find: { open: false, query: "", caseSensitive: false, done: true, count: 0, capped: false, active: -1 }
}

function groupIds(searchable?: boolean): string[] {
	const { result } = renderHook(() =>
		usePdfCommandParts({
			state: STATE,
			dispatch: () => undefined,
			document: {} as PdfDomDocument,
			outline: [],
			findFocus: 0,
			onFindClosed: () => undefined,
			onDownload: null,
			onPrint: undefined,
			onProperties: () => undefined,
			pageInputRef: { current: null },
			scrollRoom: PDF_SCROLL_ROOM_ANY,
			...(searchable === undefined ? {} : { searchable })
		})
	)

	return result.current.groups.map(group => group.id)
}

describe("usePdfCommandParts", () => {
	it("offers Find unless the document is not searchable", () => {
		expect(groupIds()).toContain("find")
		expect(groupIds(false)).not.toContain("find")
	})
})
