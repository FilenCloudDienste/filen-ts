import { AnyNormalDir_Tags, type AnyNormalDir } from "@filen/sdk-rs"
import type { CopyDestination } from "@/features/copy/copyAdapter"
import cache from "@/lib/cache"
import i18n from "@/lib/i18n"

// The copy destination a directory stands for: the root as { uuid: null } under the drive's name.
export function copyDestinationOf(dir: AnyNormalDir): CopyDestination {
	const uuid = dir.inner[0].uuid

	return dir.tag === AnyNormalDir_Tags.Root || uuid === cache.rootUuid
		? { uuid: null, name: i18n.t("drive") }
		: { uuid, name: cache.uuidToAnyDriveItem.get(uuid)?.data.decryptedMeta?.name ?? uuid }
}
