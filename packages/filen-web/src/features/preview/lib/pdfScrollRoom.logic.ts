import { isPdfCommandEnabled, type PdfViewerCommandType, type PdfViewerState } from "@filen/office/dom/pdf"

// Whether the page column can scroll further up (back) or down (forward). Where it cannot, stepping a page that way
// moves nothing: the page commands that way are off, and the page shown stays the one most in view.
export interface PdfScrollRoom {
	readonly back: boolean
	readonly forward: boolean
}

// Before the column is measured: nothing is held back.
export const PDF_SCROLL_ROOM_ANY: PdfScrollRoom = { back: true, forward: true }

// A scroll position a fraction of a pixel short of an end (a zoomed or high-DPI layout) is at that end.
const END_SLACK_PX = 1

export function pdfScrollRoom(scrollTop: number, clientHeight: number, scrollHeight: number): PdfScrollRoom {
	return { back: scrollTop > END_SLACK_PX, forward: scrollTop + clientHeight < scrollHeight - END_SLACK_PX }
}

export function sameScrollRoom(a: PdfScrollRoom, b: PdfScrollRoom): boolean {
	return a.back === b.back && a.forward === b.forward
}

// isPdfCommandEnabled, with the page steps also needing room to scroll their way.
export function pdfPageCommandEnabled(state: PdfViewerState, type: PdfViewerCommandType, room: PdfScrollRoom): boolean {
	switch (type) {
		case "page.previous":
		case "page.first":
			return room.back && isPdfCommandEnabled(state, type)
		case "page.next":
		case "page.last":
			return room.forward && isPdfCommandEnabled(state, type)
		default:
			return isPdfCommandEnabled(state, type)
	}
}
