import { useTranslation } from "react-i18next"
import { useAccountQuery } from "@/queries/account"
import { useDirectoryNamesQuery } from "@/features/drive/queries/drive"

// A pair's remote directory name by its uuid, read through the drive's own name entries: a cached listing row
// first, then one cache-first worker lookup shared with every breadcrumb naming the same directory. null while
// it resolves. The account's root (a migrated pair the engine cannot sync yet) reads as the drive's name.
export function useRemoteDirectoryName(uuid: string): string | null {
	const { t } = useTranslation(["drive", "sync"])
	const accountRoot = useAccountQuery().data?.rootDirUuid
	const isAccountRoot = accountRoot !== undefined && uuid === accountRoot
	const names = useDirectoryNamesQuery(isAccountRoot || uuid.length === 0 ? [] : [uuid])

	if (isAccountRoot) {
		return t("drive:driveMyDrive")
	}

	if (names.status === "pending") {
		return null
	}

	return names.data?.[uuid] ?? t("sync:syncRemoteUnknown")
}
