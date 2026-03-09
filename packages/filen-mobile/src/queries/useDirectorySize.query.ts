import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, useDefaultQueryParams } from "@/queries/client"
import auth from "@/lib/auth"
import useRefreshOnFocus from "@/queries/useRefreshOnFocus"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import { AnyDirWithContext_Tags, AnyDirWithContext, AnyNormalDir, AnyNormalDir_Tags, ParentUuid } from "@filen/sdk-rs"
import offline from "@/lib/offline"
import { unwrapDirMeta, unwrappedDirIntoDriveItem } from "@/lib/utils"

export const BASE_QUERY_KEY = "useDirectorySizeQuery"

export type UseDirectorySizeQueryParams = {
	uuid: string
	type: "offline" | "trash" | "sharedIn" | "sharedOut" | "normal"
}

export async function fetchData(
	params: UseDirectorySizeQueryParams & {
		signal?: AbortSignal
	}
): Promise<{
	size: number
	files: number
	dirs: number
}> {
	let anyDirWithContext = cache.directoryUuidToAnyDirWithContext.get(params.uuid) ?? null

	if (!anyDirWithContext) {
		return {
			size: 0,
			files: 0,
			dirs: 0
		}
	}

	if (params.type === "offline") {
		return await offline.itemSize(unwrappedDirIntoDriveItem(unwrapDirMeta(anyDirWithContext)))
	}

	// Hack so we can get the size of items in the trash
	if (
		params.type === "trash" &&
		anyDirWithContext.tag === AnyDirWithContext_Tags.Normal &&
		anyDirWithContext.inner[0].tag === AnyNormalDir_Tags.Dir
	) {
		anyDirWithContext = new AnyDirWithContext.Normal(
			new AnyNormalDir.Dir({
				...anyDirWithContext.inner[0].inner[0],
				parent: new ParentUuid.Trash()
			})
		)
	}

	const { authedSdkClient } = await auth.getSdkClients()
	const { size, files, dirs } = await authedSdkClient.getDirSize(
		anyDirWithContext,
		params?.signal
			? {
					signal: params.signal
				}
			: undefined
	)

	return {
		size: Number(size),
		files: Number(files),
		dirs: Number(dirs)
	}
}

export function useDirectorySizeQuery(
	params: UseDirectorySizeQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const defaultParams = useDefaultQueryParams(options)
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...defaultParams,
		...options,
		queryKey: [BASE_QUERY_KEY, sortedParams],
		queryFn: ({ signal }) =>
			fetchData({
				...sortedParams,
				signal
			})
	})

	useRefreshOnFocus({
		isEnabled: query.isEnabled,
		refetch: query.refetch
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export default useDirectorySizeQuery
