import { type SharingRole, type ShareInfo } from "@filen/sdk-rs"
import { type DriveItem } from "@/types"
import cache from "@/lib/cache"

// DUAL-SURFACE (see project memory "SDK-rs dual surface"): the package's .d.ts types
// SharingRole as { Sharer: ShareInfo } | { Receiver: ShareInfo }, but the RN uniffi RUNTIME
// value is a tagged enum { tag, inner: [ShareInfo] }. We read whichever shape is present so the
// helper is correct at runtime (RN) and type-checks against the .d.ts. Likewise ShareInfo.id is
// `number` on the .d.ts but `bigint` at runtime — BigInt() normalizes both.
type RuntimeSharingRole = {
	inner?: readonly ShareInfo[]
	Sharer?: ShareInfo
	Receiver?: ShareInfo
}

function shareInfoFromRole(role: SharingRole | undefined): ShareInfo | null {
	if (!role) {
		return null
	}

	const r = role as unknown as RuntimeSharingRole

	if (r.inner && r.inner.length > 0 && r.inner[0]) {
		return r.inner[0]
	}

	return r.Sharer ?? r.Receiver ?? null
}

// Resolves the OTHER party's identity for a shared item (in the sharedIn context this is the
// sharer). Returns null when the item isn't a shared item or the sharer can't be determined.
export function getSharerIdentity(item: DriveItem): { userId: bigint; email: string } | null {
	let role: SharingRole | undefined

	switch (item.type) {
		case "sharedRootFile":
		case "sharedFile":
		case "sharedRootDirectory": {
			role = item.data.sharingRole

			break
		}

		case "sharedDirectory": {
			role = item.data.sharingRole ?? cache.directoryUuidToAnySharedDirWithContext.get(item.data.uuid)?.shareInfo

			break
		}

		default: {
			return null
		}
	}

	const info = shareInfoFromRole(role)

	if (!info) {
		return null
	}

	return {
		userId: BigInt(info.id),
		email: info.email
	}
}
