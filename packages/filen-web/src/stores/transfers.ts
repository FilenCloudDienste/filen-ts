import { create } from "zustand"
import { useShallow } from "zustand/shallow"
import type { ErrorDTO } from "@/lib/sdk/errors"

// One row per in-flight or finished transfer, in-memory only (no persistence — mirrors
// useDriveStore's selection state, not a query). `direction` leaves room for a future "download" arm
// without reshaping this type — only "upload" rows are created today. No "cancelled" status —
// cancel/abort is out of scope for now (see lib/drive/upload.ts's runUpload doc comment); it arrives
// alongside the download direction later.
export interface Transfer {
	id: string
	direction: "upload"
	name: string
	size: number
	bytesTransferred: number
	status: "uploading" | "done" | "error"
	// Present only once status is "error" — exactOptionalPropertyTypes forbids assigning `undefined`
	// to this key explicitly, so settle() below only ever spreads it in when actually provided.
	error?: ErrorDTO
	parentUuid: string | null
	startedAt: number
}

export interface TransfersStore {
	transfers: Transfer[]
	add: (transfer: Transfer) => void
	setProgress: (id: string, bytesTransferred: number) => void
	settle: (id: string, status: "done" | "error", error?: ErrorDTO) => void
	remove: (id: string) => void
	// Drops every non-"uploading" row (done or error); active uploads are left untouched. Backs a
	// future transfers panel's "clear finished" control.
	clearFinished: () => void
}

export const useTransfersStore = create<TransfersStore>(set => ({
	transfers: [],
	add: transfer => {
		set(state => ({ transfers: [...state.transfers, transfer] }))
	},
	setProgress: (id, bytesTransferred) => {
		set(state => ({
			transfers: state.transfers.map(transfer => (transfer.id === id ? { ...transfer, bytesTransferred } : transfer))
		}))
	},
	settle: (id, status, error) => {
		set(state => ({
			transfers: state.transfers.map(transfer =>
				transfer.id === id ? (error === undefined ? { ...transfer, status } : { ...transfer, status, error }) : transfer
			)
		}))
	},
	remove: id => {
		set(state => ({ transfers: state.transfers.filter(transfer => transfer.id !== id) }))
	},
	clearFinished: () => {
		set(state => ({ transfers: state.transfers.filter(transfer => transfer.status === "uploading") }))
	}
}))

// Plain, testable aggregate math — mirrors fetchDirectoryListing/useDirectoryListingQuery's split
// (queries/drive.ts): the hook below is a one-line wrapper this project's node-environment unit
// tests can't render (no DOM — see vitest.config.ts), so the math itself is exported and unit-tested
// directly against plain Transfer arrays. `percent` is the raw 0..1 ratio (summed transferred /
// summed size across active rows), not a 0-100 scale — a consumer multiplies by 100 for display.
export function computeTransfersAggregate(transfers: Transfer[]): { activeCount: number; percent: number } {
	let activeCount = 0
	let transferred = 0
	let total = 0

	for (const transfer of transfers) {
		if (transfer.status !== "uploading") {
			continue
		}

		activeCount++
		transferred += transfer.bytesTransferred
		total += transfer.size
	}

	return { activeCount, percent: activeCount === 0 || total === 0 ? 0 : transferred / total }
}

// Selector hook, not a plain accessor — React-Compiler standing constraint: a component reads this
// store through a selector hook returning primitives/stable refs, never `.getState()` in render.
// useShallow keeps the returned object's IDENTITY stable across renders where neither field actually
// changed (mirrors directory-listing.tsx's own useShallow(state => state.selectedItems)), since
// computeTransfersAggregate otherwise returns a brand-new object on every store update.
export function useTransfersAggregate(): { activeCount: number; percent: number } {
	return useTransfersStore(useShallow(state => computeTransfersAggregate(state.transfers)))
}
