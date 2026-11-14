import * as Comlink from "comlink"
import { useSyncExternalStore } from "react"
import type { SocketEvent } from "@filen/sdk-rs"
import {
	addPdfSignature,
	deletePdfSignature,
	emptyPdfSignatures,
	isStorablePdfSignature,
	mergePdfSignatures,
	parsePdfSignatures,
	PDF_SIGNATURES_FILE_NAME,
	PdfSignaturesVersionError,
	samePdfSignatures,
	serializePdfSignatures,
	type PdfSignaturesDoc,
	type SavedPdfSignature,
	type SavedPdfSignatureData
} from "@filen/shared/pdfSignatures"
import type { PdfSignatureRole, PdfVisualSignature } from "@filen/office/core/pdfedit/visualSignature"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { onDotFilenSubdirForgotten } from "@/lib/dotFilen"
import { OFFICE_DIR_NAME, officeDirectory } from "@/features/office/lib/officeDirectory"
import { SYNCED_FILE_UPLOAD_DEADLINE_MS, SyncedDotFilenFile, type SyncedFileCodec, type SyncedFileSdk } from "@/lib/syncedDotFilenFile"
import { base64ToBytes, bytesToBase64 } from "@/features/videos/lib/frames.logic"

// The user's saved visual signatures and initials for Fill & Sign, synced end-to-end encrypted as
// `.filen/office/pdf-signatures.v1.json` (lib/syncedDotFilenFile.ts, format in @filen/shared/pdfSignatures): read
// when the signature dialog or Settings › Office first needs them; a save or delete shows at once and is merged into
// the file as it stands before the upload. Strokes are stored as compact integer vectors, images as small PNGs.

const CODEC: SyncedFileCodec<PdfSignaturesDoc> = {
	fileName: PDF_SIGNATURES_FILE_NAME,
	// 8 entries per role, each at most a 256 KiB PNG in base64, with room to spare.
	maxBytes: 8 * 1024 * 1024,
	scope: "pdf",
	empty: emptyPdfSignatures,
	parse: parsePdfSignatures,
	isNewerFormat: error => error instanceof PdfSignaturesVersionError,
	serialize: serializePdfSignatures,
	merge: mergePdfSignatures,
	same: samePdfSignatures
}

type DriveSocketEvent = Extract<SocketEvent, { type: "drive" }>

export interface SavedSignaturesView {
	// The file was read this session (or found missing).
	readonly loaded: boolean
	// Written by a newer app: shown, never changed here.
	readonly readOnly: boolean
	// Newest first.
	readonly signatures: readonly SavedPdfSignature[]
	readonly initials: readonly SavedPdfSignature[]
}

// The stored form of a signature the dialog made.
export function storedSignatureData(signature: PdfVisualSignature): SavedPdfSignatureData {
	return signature.kind === "strokes"
		? { kind: "strokes", width: signature.width, height: signature.height, strokes: signature.strokes }
		: { kind: "image", width: signature.width, height: signature.height, png: bytesToBase64(signature.png) }
}

// Saved entries are immutable: each decodes once.
const decoded = new WeakMap<SavedPdfSignature, PdfVisualSignature>()

// A saved entry as the dialog hands it to the page.
export function savedVisualSignature(saved: SavedPdfSignature): PdfVisualSignature {
	const cached = decoded.get(saved)

	if (cached !== undefined) return cached

	const data = saved.data
	const signature: PdfVisualSignature =
		data.kind === "strokes"
			? { kind: "strokes", width: data.width, height: data.height, strokes: data.strokes }
			: { kind: "image", width: data.width, height: data.height, png: base64ToBytes(data.png) }

	decoded.set(saved, signature)

	return signature
}

export class SavedSignaturesStore {
	private readonly file: SyncedDotFilenFile<PdfSignaturesDoc>
	private readonly now: () => number
	private readonly newId: () => string
	private cached: { doc: PdfSignaturesDoc; loaded: boolean; readOnly: boolean; view: SavedSignaturesView } | null = null

	constructor(sdk: SyncedFileSdk, now: () => number = Date.now, newId: () => string = () => crypto.randomUUID()) {
		this.file = new SyncedDotFilenFile(sdk, CODEC)
		this.now = now
		this.newId = newId
	}

	// Replaced only when something changed, for useSyncExternalStore.
	view(): SavedSignaturesView {
		const doc = this.file.value()
		const loaded = this.file.isLoaded
		const readOnly = this.file.isReadOnly

		if (this.cached?.doc !== doc || this.cached.loaded !== loaded || this.cached.readOnly !== readOnly) {
			this.cached = {
				doc,
				loaded,
				readOnly,
				view: {
					loaded,
					readOnly,
					signatures: doc.items.filter(item => item.role === "signature"),
					initials: doc.items.filter(item => item.role === "initials")
				}
			}
		}

		return this.cached.view
	}

	subscribe(listener: () => void): () => void {
		return this.file.subscribe(listener)
	}

	load(): Promise<void> {
		return this.file.load()
	}

	// Shown at once; resolves with the entry once stored (rejects when the upload failed or the file is read-only:
	// the entry is then not kept for later, the signature is still placed).
	async save(role: PdfSignatureRole, signature: PdfVisualSignature): Promise<SavedPdfSignature> {
		const item: SavedPdfSignature = { id: this.newId(), role, at: this.now(), data: storedSignatureData(signature) }

		if (!isStorablePdfSignature(item.data)) throw new Error("signature too large to save")

		await this.file.change(doc => addPdfSignature(doc, item), { requireWritable: true })

		return item
	}

	delete(id: string): Promise<void> {
		return this.file.change(doc => deletePdfSignature(doc, id, this.now()), { requireWritable: true })
	}

	handleDriveEvent(event: DriveSocketEvent): void {
		this.file.handleDriveEvent(event)
	}

	markStale(): void {
		this.file.markStale()
	}

	reset(): void {
		this.file.reset()
	}
}

export const savedSignatures = /* @__PURE__ */ new SavedSignaturesStore({
	...officeDirectory,
	upload: (parent, bytes) =>
		runOp(
			sdkApi.uploadFileBytes(parent, Comlink.transfer(bytes, [bytes.buffer]), PDF_SIGNATURES_FILE_NAME, "application/json", {
				deadlineMs: SYNCED_FILE_UPLOAD_DEADLINE_MS,
				abortToken: crypto.randomUUID()
			})
		)
})

function subscribe(listener: () => void): () => void {
	return savedSignatures.subscribe(listener)
}

function view(): SavedSignaturesView {
	return savedSignatures.view()
}

// The saved signatures and initials; subscribing keeps them fresh. Call loadSavedSignatures() where they are shown.
export function useSavedSignatures(): SavedSignaturesView {
	return useSyncExternalStore(subscribe, view, view)
}

export function loadSavedSignatures(): Promise<void> {
	return savedSignatures.load()
}

// Sign-out: nothing of the account stays.
export function resetSavedSignatures(): void {
	savedSignatures.reset()
}

// Called once by the authed shell's socket host.
export function registerSavedSignaturesSocketHandlers(): () => void {
	const unregister = [
		registerSocketHandler("drive", event => {
			savedSignatures.handleDriveEvent(event)
		}),
		registerSocketHandler("driveMalformed", () => {
			savedSignatures.markStale()
		}),
		registerSocketHandler("reconnecting", () => {
			savedSignatures.markStale()
		}),
		onDotFilenSubdirForgotten(OFFICE_DIR_NAME, () => {
			savedSignatures.markStale()
		})
	]

	return () => {
		for (const off of unregister) off()
	}
}
