import * as Comlink from "comlink"
import { sdkApi } from "@/lib/sdk/client"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"

// The page's end of the SDK worker's one progress channel (sdk.worker.ts's postProgress): every upload and
// download moves its bytes through this, one store write per batch, rather than one Comlink proxy and
// MessageChannel per transfer.

const listeners = new Map<string, (bytes: number) => void>()
let opened = false

export function applyProgressBatch(bytesById: Readonly<Record<string, number>>): void {
	useTransfersStore.getState().setProgressMany(bytesById)

	if (listeners.size === 0) {
		return
	}

	for (const id in bytesById) {
		const bytes = bytesById[id]

		if (bytes !== undefined) {
			listeners.get(id)?.(bytes)
		}
	}
}

// Called before every transfer op that reports through the channel: the registration is posted on the
// worker's own port ahead of the op, so the worker holds the sink before the op's first byte.
export function openProgressChannel(): void {
	if (opened) {
		return
	}

	opened = true

	void sdkApi.setProgressSink(Comlink.proxy(applyProgressBatch))
}

// A transfer whose bytes something besides its row follows (a chat attachment's composer); returns the
// unsubscribe.
export function onTransferProgress(id: string, listener: (bytes: number) => void): () => void {
	listeners.set(id, listener)

	return () => {
		listeners.delete(id)
	}
}
