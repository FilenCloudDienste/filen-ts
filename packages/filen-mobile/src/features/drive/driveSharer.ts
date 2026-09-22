import { type SharingRole } from "@filen/sdk-rs"
import { type ShareIdentity, shareIdentityFromRole } from "@filen/shared"
import { type DriveItem } from "@/types"
import cache from "@/lib/cache"

// Resolves the OTHER party's identity for a shared item (in the sharedIn context this is the
// sharer). Returns null when the item isn't a shared item or the sharer can't be determined. The
// dual-surface unwrap itself (uniffi `.inner` vs wasm `.Sharer`/`.Receiver`) lives in
// shareIdentityFromRole (@filen/shared).
export function getSharerIdentity(item: DriveItem): ShareIdentity | null {
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

	return shareIdentityFromRole(role)
}
