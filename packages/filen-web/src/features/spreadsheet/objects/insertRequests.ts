import { useSyncExternalStore } from "react"
import type { SheetGridModel } from "@filen/office/react/sheet"

// A picture asked for from outside the objects feature (the ribbon's Insert tab): from this device's file chooser
// or the drive's picker. The objects feature takes the request and clears it.

export type ImageSource = "file" | "drive"

export interface ImageRequest {
	readonly source: ImageSource
	readonly nonce: number
}

interface RequestStore {
	request: ImageRequest | null
	nonce: number
	readonly listeners: Set<() => void>
}

const stores = new WeakMap<SheetGridModel, RequestStore>()

function storeOf(model: SheetGridModel): RequestStore {
	let store = stores.get(model)

	if (store === undefined) {
		store = { request: null, nonce: 0, listeners: new Set() }
		stores.set(model, store)
	}

	return store
}

function notify(store: RequestStore): void {
	for (const listener of store.listeners) {
		listener()
	}
}

export function requestImage(model: SheetGridModel, source: ImageSource): void {
	const store = storeOf(model)

	store.nonce++
	store.request = { source, nonce: store.nonce }
	notify(store)
}

export function clearImageRequest(model: SheetGridModel, nonce: number): void {
	const store = storeOf(model)

	if (store.request?.nonce !== nonce) {
		return
	}

	store.request = null
	notify(store)
}

export function useImageRequest(model: SheetGridModel): ImageRequest | null {
	const store = storeOf(model)

	return useSyncExternalStore(
		listener => {
			store.listeners.add(listener)

			return () => {
				store.listeners.delete(listener)
			}
		},
		() => store.request,
		() => store.request
	)
}
