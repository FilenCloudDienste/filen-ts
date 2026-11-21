import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react"
import type { Note } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import { createListenerSet } from "@/lib/listenerSet"

// The document the user has open (a previewed PDF, Word document, spreadsheet, deck or text file, or a note): one entry,
// written only by the viewer showing it. Its reader reads the viewer's own engine when asked, so no text is held here.

export type ActiveDocumentKind = "pdf" | "docx" | "sheet" | "slides" | "text" | "note"

// Where the user is in it (1-based), and how much there is.
export interface ActiveDocumentPosition {
	readonly page?: number
	readonly pages?: number
	readonly sheet?: string
	readonly sheets?: readonly string[]
	readonly slide?: number
	readonly slides?: number
}

// What a read returns: the text, where each unit (page, sheet, slide) starts in it, and whether it was cut short (at
// the characters asked for, or past what the viewer holds yet).
export interface DocumentText {
	readonly text: string
	readonly units: readonly { readonly label: string; readonly start: number }[]
	readonly truncated: boolean
}

// Units (pages, sheets or slides) from `from` to `to`, 1-based and inclusive, or the user's selection.
export type DocumentRange = { readonly from: number; readonly to: number } | "selection"

export interface DocumentReader {
	// Pages, sheets or slides; 1 for a text.
	units(): Promise<number>
	text(range: DocumentRange, signal: AbortSignal, maxChars: number): Promise<DocumentText>
}

export interface ActiveDocument {
	// The publisher's: only it replaces or clears its entry.
	readonly token: symbol
	readonly item: DriveItem | { readonly kind: "note"; readonly note: Note }
	readonly kind: ActiveDocumentKind
	readonly position: ActiveDocumentPosition
	// A size only: the selected text stays in the editor.
	readonly selection: { readonly chars: number } | null
	readonly editable: boolean
	readonly reader: DocumentReader
}

let current: ActiveDocument | null = null
let currentSignature: string | null = null
const listeners = createListenerSet("activeDocument")

function itemKey(item: ActiveDocument["item"]): string {
	return "note" in item ? `note:${item.note.uuid}` : `item:${item.data.uuid}`
}

// Two entries a subscriber cannot tell apart (the reader aside, which reads the publisher's latest engine) share one.
function signatureOf(entry: Omit<ActiveDocument, "token" | "reader">): string {
	return JSON.stringify([itemKey(entry.item), entry.kind, entry.position, entry.selection?.chars ?? null, entry.editable])
}

export function getActiveDocument(): ActiveDocument | null {
	return current
}

export function subscribeActiveDocument(listener: () => void): () => void {
	return listeners.subscribe(listener)
}

// Replaces the entry; telling subscribers only when what they see changed.
export function publishActiveDocument(entry: ActiveDocument): void {
	const signature = signatureOf(entry)

	if (current?.token === entry.token && current.reader === entry.reader && currentSignature === signature) {
		return
	}

	current = entry
	currentSignature = signature
	listeners.emit()
}

// Clears the entry if it is still `token`'s: a viewer going away never clears the one that replaced it.
export function clearActiveDocument(token: symbol): void {
	if (current?.token !== token) {
		return
	}

	current = null
	currentSignature = null
	listeners.emit()
}

export function useActiveDocument(): ActiveDocument | null {
	return useSyncExternalStore(subscribeActiveDocument, getActiveDocument)
}

// What a viewer publishes about its document; null while it has nothing to read (loading, failed, locked).
export type ActiveDocumentPublication = Omit<ActiveDocument, "token" | "item">

const NOTHING_SELECTED: DocumentText = { text: "", units: [], truncated: false }

// A read of the selection by a viewer that has none to offer.
export function noSelection(): Promise<DocumentText> {
	return Promise.resolve(NOTHING_SELECTED)
}

// A read of a document whose viewer has gone.
function closedDocument(): Promise<never> {
	return Promise.reject(new Error("The document is no longer open"))
}

// Publishes `publication` for `item` while both are there: once a frame at most, and only when something a subscriber
// sees changed. The entry's reader calls the latest one the viewer committed, and refuses once the viewer unmounted.
// Unmounting (or a null) clears the entry only while it is still this viewer's.
export function usePublishActiveDocument(item: ActiveDocument["item"] | null, publication: ActiveDocumentPublication | null): void {
	const [token] = useState(() => Symbol("activeDocument"))
	const readerRef = useRef<DocumentReader | null>(null)
	const latestReader = publication?.reader ?? null
	const [reader] = useState<DocumentReader>(() => ({
		units: () => readerRef.current?.units() ?? closedDocument(),
		text: (range, signal, maxChars) => readerRef.current?.text(range, signal, maxChars) ?? closedDocument()
	}))
	const signature = item === null || publication === null ? null : signatureOf({ ...publication, item })
	const publish = useEffectEvent(() => {
		if (item !== null && publication !== null) {
			publishActiveDocument({ ...publication, item, token, reader })
		}
	})

	useEffect(() => {
		readerRef.current = latestReader
	}, [latestReader])

	useEffect(() => {
		if (signature === null) {
			clearActiveDocument(token)

			return
		}

		const frame = requestAnimationFrame(() => {
			publish()
		})

		return () => {
			cancelAnimationFrame(frame)
		}
	}, [signature, token])

	useEffect(() => {
		return () => {
			readerRef.current = null
			clearActiveDocument(token)
		}
	}, [token])
}
