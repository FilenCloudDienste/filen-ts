import type { DriveItem } from "@/types"
import { type OfflineParent } from "@/features/offline/offlineHelpers"
import offline from "@/features/offline/offline"
import { appendOfflineSyncErrors } from "@/features/offline/store/useOffline.store"
import { isFileItem } from "@/features/drive/driveSelectors"

export async function storeItemOffline({ item, parent }: { item: DriveItem; parent: OfflineParent }): Promise<void> {
	if (isFileItem(item)) {
		await offline.storeFile({ file: item, parent })

		return
	}

	// Degraded warnings (e.g. a remote file whose content is shorter than its metadata claims) mean
	// the store COMMITTED — surface them via the offline error badge/list, since sync passes won't
	// re-warn for an already-recorded observation.
	appendOfflineSyncErrors((await offline.storeDirectory({ directory: item, parent })).filter(error => error.degraded === true))
}
