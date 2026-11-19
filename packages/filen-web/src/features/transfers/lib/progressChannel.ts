import * as Comlink from "comlink"
import { sdkApi } from "@/lib/sdk/client"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"

// The page's end of the SDK worker's one progress channel (sdk.worker.ts's postProgress): every upload and
// download moves its bytes through this, one store write per batch, rather than one Comlink proxy and
// MessageChannel per transfer.

let opened = false

export function applyProgressBatch(bytesById: Readonly<Record<string, number>>): void {
	useTransfersStore.getState().setProgressMany(bytesById)
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
