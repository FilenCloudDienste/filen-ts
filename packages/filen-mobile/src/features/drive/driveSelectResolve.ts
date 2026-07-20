import { AnyNormalDir } from "@filen/sdk-rs"
import { type Events } from "@/lib/events"
import cache from "@/lib/cache"
import logger from "@/lib/logger"

type DriveSelectSelectedItem = Extract<Events["driveSelect"], { cancelled: false }>["selectedItems"][number]

// Resolves a driveSelect picker result element to the AnyNormalDir a caller can upload/import into.
// Root passes straight through. For a picked own-directory: prefer the cache entry (populated by a
// listing) and fall back to building the AnyNormalDir.Dir by value from the selected item (the same
// plain Dir shape the transfer/offline paths use). A cache miss — the directory was never observed by
// a listing — must NOT no-op silently, leaving the user's pick with no effect and no log. Shared
// directories carry no plain Dir struct and aren't valid destinations, so those resolve to null
// (logged with the uuid + type), as does anything unexpected.
export function resolveSelectedDriveItemToAnyNormalDir(selectedItem: DriveSelectSelectedItem): AnyNormalDir | null {
	if (selectedItem.type === "root") {
		return selectedItem.data
	}

	const fromCache = cache.directoryUuidToAnyNormalDir.get(selectedItem.data.data.uuid)

	if (fromCache) {
		return fromCache
	}

	if (selectedItem.data.type === "directory") {
		return new AnyNormalDir.Dir(selectedItem.data.data)
	}

	logger.warn("drive", "Could not resolve picked destination to a usable directory", {
		uuid: selectedItem.data.data.uuid,
		type: selectedItem.data.type
	})

	return null
}
