import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react"
import type { Note } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import { createListenerSet } from "@/lib/listenerSet"
import { DocumentTextBuilder } from "@/lib/documentText"
import { log } from "@/lib/log"

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

// Units (pages, sheets, slides) from `from` to `to`, 1-based and inclusive.
export interface UnitRange {
	readonly from: number
	readonly to: number
}

// A unit range, or the user's selection.
export type DocumentRange = UnitRange | "selection"

// What a viewer reads of its document: its units.
export interface UnitReader {
	// Pages, sheets or slides; 1 for a text.
	units(): Promise<number>
	text(range: UnitRange, signal: AbortSignal, maxChars: number): Promise<DocumentText>
}

export interface DocumentReader {
	units(): Promise<number>
	text(range: DocumentRange, signal: AbortSignal, maxChars: number): Promise<DocumentText>
}

// The user's selection in a viewer, read from its editor when asked: its size after a change (no text copied where
// the editor can tell it otherwise), its text for a read. An editor's selection transform host is one.
export interface SelectionReader {
	// The characters selected now; 0 for none.
	selectedChars(signal: AbortSignal): number | Promise<number>
	// The selected text now ("" for none): at least its first `maxChars` characters.
	selectedText(maxChars: number, signal: AbortSignal): string | Promise<string>
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

// What a viewer publishes about its document; null while it has nothing to read (loading, failed, locked). Its
// selection, where it has one, is read through `selection`: the size when it changes, the text when a reader asks.
export interface ActiveDocumentPublication {
	readonly kind: ActiveDocumentKind
	readonly position: ActiveDocumentPosition
	readonly editable: boolean
	readonly reader: UnitReader
	readonly selection?: SelectionReader | null
}

// A read of a document whose viewer has gone.
function closedDocument(): Promise<never> {
	return Promise.reject(new Error("The document is no longer open"))
}

function selectionOf(chars: number): ActiveDocument["selection"] {
	return chars > 0 ? { chars } : null
}

// A selection's size, measured a frame at most after a change is heard (the latest measure wins: one still running is
// aborted), and told on only when it differs from the last.
class SelectionMeasure {
	private source: SelectionReader | null = null
	private size = 0
	private frame: number | null = null
	private running: AbortController | null = null
	private readonly changed: (chars: number) => void

	constructor(changed: (chars: number) => void) {
		this.changed = changed
	}

	get chars(): number {
		return this.size
	}

	get reader(): SelectionReader | null {
		return this.source
	}

	// Measures `source` from now on (null: nothing selected).
	follow(source: SelectionReader | null): void {
		this.source = source
		this.schedule()
	}

	schedule(): void {
		if (this.frame !== null) {
			return
		}

		this.frame = requestAnimationFrame(() => {
			this.frame = null
			this.measure()
		})
	}

	dispose(): void {
		if (this.frame !== null) {
			cancelAnimationFrame(this.frame)
			this.frame = null
		}

		this.running?.abort()
		this.running = null
		this.source = null
		this.size = 0
	}

	private measure(): void {
		this.running?.abort()
		this.running = null

		const source = this.source

		if (source === null) {
			this.settle(0)

			return
		}

		const running = new AbortController()
		const settle = (chars: number): void => {
			if (!running.signal.aborted) {
				this.running = null
				this.settle(chars)
			}
		}
		const failed = (error: unknown): void => {
			if (!running.signal.aborted) {
				log.warn("activeDocument", "selection size unreadable", error)
				settle(0)
			}
		}

		this.running = running

		try {
			const measured = source.selectedChars(running.signal)

			if (typeof measured === "number") {
				settle(measured)
			} else {
				measured.then(settle, failed)
			}
		} catch (e) {
			failed(e)
		}
	}

	private settle(chars: number): void {
		if (chars !== this.size) {
			this.size = chars
			this.changed(chars)
		}
	}
}

// Publishes `publication` for `item` while both are there: once a frame at most, and only when something a subscriber
// sees changed. The entry's reader calls the latest one the viewer committed, and refuses once the viewer unmounted.
// Unmounting (or a null) clears the entry only while it is still this viewer's.
// A publication's selection is measured when first given, on each selection change the page hears (the document's
// selectionchange and select), and when the returned function is called (by an editor that draws its own selection,
// on its selection events): a frame at most, the entry replaced only when the size changed. Typing with nothing
// selected costs one check of an empty selection a frame.
export function usePublishActiveDocument(item: ActiveDocument["item"] | null, publication: ActiveDocumentPublication | null): () => void {
	const [token] = useState(() => Symbol("activeDocument"))
	const readerRef = useRef<UnitReader | null>(null)
	const latestReader = publication?.reader ?? null
	const latestSelection = publication?.selection ?? null
	const [measure] = useState(
		() =>
			new SelectionMeasure(chars => {
				const held = getActiveDocument()

				if (held?.token === token) {
					publishActiveDocument({ ...held, selection: selectionOf(chars) })
				}
			})
	)
	const [reader] = useState<DocumentReader>(() => ({
		units: () => readerRef.current?.units() ?? closedDocument(),
		text: async (range, signal, maxChars) => {
			const open = readerRef.current

			if (open === null) {
				return closedDocument()
			}

			if (range !== "selection") {
				return open.text(range, signal, maxChars)
			}

			const builder = new DocumentTextBuilder(maxChars)
			const text = (await measure.reader?.selectedText(maxChars, signal)) ?? ""

			signal.throwIfAborted()

			if (text.length > 0) {
				builder.add("selection", text)
			}

			return builder.result()
		}
	}))
	const [selectionChanged] = useState(() => () => {
		measure.schedule()
	})
	const signature = item === null || publication === null ? null : signatureOf({ ...publication, item, selection: null })
	const publish = useEffectEvent(() => {
		if (item !== null && publication !== null) {
			publishActiveDocument({
				kind: publication.kind,
				position: publication.position,
				editable: publication.editable,
				item,
				token,
				reader,
				selection: selectionOf(measure.chars)
			})
		}
	})
	const selects = latestSelection !== null

	useEffect(() => {
		readerRef.current = latestReader
	}, [latestReader])

	useEffect(() => {
		measure.follow(latestSelection)
	}, [measure, latestSelection])

	useEffect(() => {
		if (!selects) {
			return
		}

		document.addEventListener("selectionchange", selectionChanged)
		document.addEventListener("select", selectionChanged, true)

		return () => {
			document.removeEventListener("selectionchange", selectionChanged)
			document.removeEventListener("select", selectionChanged, true)
		}
	}, [selects, selectionChanged])

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
			measure.dispose()
			clearActiveDocument(token)
		}
	}, [token, measure])

	return selectionChanged
}

// The selection inside an element's DOM (a PDF's text layer, a rendered document), the element attached after each
// commit: kept while the user turns to something else (the assistant's composer), dropped once they click or select
// inside the element again. Held as a live Range, so text the page no longer shows (a page scrolled out and unmounted)
// reads as nothing.
export function elementSelection(): { reader: SelectionReader; attach: (root: Node | null) => void } {
	let element: Node | null = null
	let kept: Range | null = null

	const read = (): string => {
		const selection = document.getSelection()

		if (element === null) {
			kept = null

			return ""
		}

		if (selection !== null && selection.rangeCount > 0 && element.contains(selection.anchorNode)) {
			kept = selection.isCollapsed || !element.contains(selection.focusNode) ? null : selection.getRangeAt(0).cloneRange()
		}

		return kept !== null && element.contains(kept.commonAncestorContainer) ? kept.toString() : ""
	}

	return {
		reader: {
			selectedChars: () => read().length,
			selectedText: () => read()
		},
		attach: root => {
			element = root
		}
	}
}
