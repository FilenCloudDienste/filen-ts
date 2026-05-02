import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import auth from "@/lib/auth"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import {
	AnyDirWithContext_Tags,
	AnyDirWithContext,
	AnyNormalDir,
	AnyNormalDir_Tags,
	ParentUuid,
	AnyLinkedDirWithContext
} from "@filen/sdk-rs"
import offline from "@/lib/offline"
import { unwrapDirMeta, unwrappedDirIntoDriveItem } from "@/lib/utils"

export const BASE_QUERY_KEY = "useDirectorySizeQuery"

export type UseDirectorySizeQueryParams = {
	uuid: string
	type: "offline" | "trash" | "sharedIn" | "sharedOut" | "normal" | "linked"
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
	let anyDirWithContext = (() => {
		switch (params.type) {
			case "normal":
			case "trash": {
				const fromCache = cache.directoryUuidToAnyNormalDir.get(params.uuid)

				if (fromCache) {
					return new AnyDirWithContext.Normal(fromCache)
				}

				return null
			}

			case "sharedIn":
			case "sharedOut": {
				const fromCache = cache.directoryUuidToAnySharedDirWithContext.get(params.uuid)

				if (fromCache) {
					return new AnyDirWithContext.Shared(fromCache)
				}

				return null
			}

			case "linked": {
				const fromCache = cache.directoryUuidToAnyLinkedDirWithMeta.get(params.uuid)

				if (fromCache) {
					return new AnyDirWithContext.Linked(
						AnyLinkedDirWithContext.new({
							dir: fromCache.dir,
							link: fromCache.meta
						})
					)
				}

				return null
			}

			case "offline": {
				return cache.directoryUuidToAnyDirWithContext.get(params.uuid) ?? null
			}
		}
	})()

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

	// Hack so we can get the size of items in the trash, pretty ugly but it works for now
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
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		// TODO: Change with API v4
		staleTime: 15 * 60 * 1000, // 15 minutes
		queryKey: [BASE_QUERY_KEY, sortedParams],
		queryFn: ({ signal }) =>
			fetchData({
				...sortedParams,
				signal
			})
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export default useDirectorySizeQuery
