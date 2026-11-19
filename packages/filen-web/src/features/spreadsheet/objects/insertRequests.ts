import type { SheetGridModel } from "@filen/office/react/sheet"
import { createModelStore } from "@/features/spreadsheet/lib/modelStore"

// A picture asked for from outside the objects feature (the ribbon's Insert tab): from this device's file chooser
// or the drive's picker. The objects feature takes the request and clears it.

export type ImageSource = "file" | "drive"

export interface ImageRequest {
	readonly source: ImageSource
	readonly nonce: number
}

// Each request is new (its nonce), so asking twice for the same source asks again.
const store = createModelStore<ImageRequest | null>(null)
let nonce = 0

export function requestImage(model: SheetGridModel, source: ImageSource): void {
	nonce++
	store.set(model, { source, nonce })
}

export function clearImageRequest(model: SheetGridModel, done: number): void {
	if (store.get(model)?.nonce === done) {
		store.set(model, null)
	}
}

export function useImageRequest(model: SheetGridModel): ImageRequest | null {
	return store.useValue(model)
}
