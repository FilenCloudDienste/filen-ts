import { originSize, originWhole, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"
import { openSyncBridge, type SyncRangeHandle } from "@/lib/media/syncRange"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"

// An origin's bytes for a synchronous reader in another worker (lib/media/syncRange.ts), under `token`, for the surface
// `access` asks from. Only for an origin read by ranges: one read whole is transferred to its engine instead.
export async function openOriginSyncSource(
	origin: ByteOrigin,
	token: string,
	options: { readonly access: OriginAccess }
): Promise<SyncRangeHandle> {
	if (originWhole(origin)) {
		throw new Error("an origin read whole has no sync source")
	}

	return await openSyncBridge(originSize(origin), (buffer, port, readerLock) =>
		runOp(sdkApi.openOriginSyncRange(buffer, port, origin, options.access, token, readerLock))
	)
}
