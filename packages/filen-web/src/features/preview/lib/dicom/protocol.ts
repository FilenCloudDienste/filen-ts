import type { PdfByteChannel } from "@filen/office/dom/pdfedit"

// What the DICOM viewer's page and its worker send each other, apart from the worker's methods: plain data only, so
// the page imports nothing of the parser, the codecs or the dictionary.

export type DicomOpenSource =
	// Through the sync range bridge; `ringBytes` is what its slots hold, counted against the budget.
	| { readonly kind: "ranged"; readonly channel: PdfByteChannel; readonly ringBytes: number }
	| { readonly kind: "whole"; readonly bytes: Uint8Array }

export type DicomOpenFailure = "notDicom" | "damaged" | "tooLarge" | "unreadable"

export type DicomImageStatus = "ok" | "noImage" | "unsupported" | "damaged" | "tooLarge"

export type DicomFrameOutcome = "ok" | "tooLarge" | "damaged" | "mismatch" | "unsupported" | "unreadable"

export type FrameFailure = Exclude<DicomFrameOutcome, "ok">

export interface DicomWindowPreset {
	readonly center: number
	readonly width: number
	readonly explanation: string | null
}

export interface DicomInfo {
	readonly image: DicomImageStatus
	readonly modality: string | null
	readonly rows: number
	readonly columns: number
	readonly frames: number
	// Milliseconds between frames for playback.
	readonly frameTimeMs: number
	// Grey levels a window applies to (not colour or palette images).
	readonly windowed: boolean
	// The file's own windows, first one the default.
	readonly windows: readonly DicomWindowPreset[]
	// Modality values are Hounsfield units (a CT rescaled to them): the CT presets apply.
	readonly hounsfield: boolean
}

// One shape for both outcomes (a union does not survive Comlink's typing): the file's figures, or why it did not open.
export interface DicomOpenResult {
	readonly info: DicomInfo | null
	readonly failure: DicomOpenFailure | null
}

// Posted by the worker through the canvas shell whenever one of these changes.
export interface DicomStatus {
	readonly frame: number
	readonly window: { readonly center: number; readonly width: number } | null
	// The window is the file's default (nothing has changed it).
	readonly atDefault: boolean
	readonly playing: boolean
	// The frame on screen could not be shown.
	readonly failure: FrameFailure | null
	// The frame on screen is decoded at a lower resolution than it has (a JPEG 2000 frame over the budget).
	readonly reduced: boolean
}

export interface DicomBudget {
	// workerDecodeBytes for this device.
	readonly decodeBytes: number
}

// One row of the tag panel (lib/dicom/tagTree.ts builds them in the worker).
export interface DicomTagRow {
	// "(0010,0010)"; an item's is "(FFFE,E000)".
	readonly tag: string
	readonly vr: string
	// From the dictionary; null for a private or unknown element.
	readonly name: string | null
	// The item's number (1-based) for an item row.
	readonly item: number | null
	// The value as text; null for binary data or a value the file does not hold in what was read.
	readonly value: string | null
	// The value's length in bytes; -1 for an undefined length.
	readonly length: number
	// Items of a sequence, elements of an item.
	readonly children: number
	readonly isPrivate: boolean
}

export interface DicomTagLevel {
	readonly rows: readonly DicomTagRow[]
	// Rows past TAG_ROWS_MAX, not sent.
	readonly more: number
}
