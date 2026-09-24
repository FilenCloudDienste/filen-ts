import { useQuery } from "@tanstack/react-query"
import auth from "@/lib/auth"
import cache from "@/lib/cache"
import logger from "@/lib/logger"
import { type LinkSaveTarget } from "@/features/drive/linkedSave"

export const LINK_OWNED_QUERY_KEY = "useLinkOwnedQuery"

// Whether the link belongs to the signed-in account: an own item already in the session cache answers
// with no request, otherwise the owner-only lookup by uuid does. A failed lookup counts as not owned,
// since it only decides whether a button shows.
export async function isLinkOwned(target: LinkSaveTarget): Promise<boolean> {
	if (target.kind === "directory" ? cache.directoryUuidToAnyNormalDir.has(target.uuid) : cache.fileUuidToNormalFile.has(target.uuid)) {
		return true
	}

	try {
		const { authedSdkClient } = await auth.getSdkClients()
		const own =
			target.kind === "directory" ? await authedSdkClient.getDirOptional(target.uuid) : await authedSdkClient.getFileOptional(target.uuid)

		return own !== undefined
	} catch (e) {
		logger.warn("drive-link", "link ownership lookup failed", { error: e, kind: target.kind, uuid: target.uuid })

		return false
	}
}

// "Save to Cloud Drive" applies to a saveable link (see linkSaveTarget) that isn't the account's own.
// Asked once per link per session; hidden until answered.
export function useLinkSaveable(target: LinkSaveTarget | null): boolean {
	const owned = useQuery({
		queryKey: [LINK_OWNED_QUERY_KEY, target],
		queryFn: async () => (target ? await isLinkOwned(target) : true),
		enabled: target !== null,
		staleTime: Infinity,
		refetchOnMount: false,
		refetchOnReconnect: false,
		refetchOnWindowFocus: false,
		retry: false
	})

	return target !== null && owned.data === false
}

export default useLinkSaveable
