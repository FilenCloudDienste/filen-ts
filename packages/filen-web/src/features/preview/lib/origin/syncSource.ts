import { originSize, originWhole, type ByteOrigin } from "@/lib/sdk/byteOrigin"
import { openSyncBridge, type SyncRangeHandle } from "@/lib/media/syncRange"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"

// An origin's bytes for a synchronous reader in another worker (lib/media/syncRange.ts), under `token`. Only for an
// origin read by ranges: one read whole is transferred to its engine instead.
export async function openOriginSyncSource(origin: ByteOrigin, token: string): Promise<SyncRangeHandle> {
	if (originWhole(origin)) {
		throw new Error("an origin read whole has no sync source")
	}

	return await openSyncBridge(originSize(origin), (buffer, port, readerLock) =>
		runOp(sdkApi.openOriginSyncRange(buffer, port, origin, token, readerLock))
	)
}
