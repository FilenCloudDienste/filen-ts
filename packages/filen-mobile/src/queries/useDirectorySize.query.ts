import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, useDefaultQueryParams } from "@/queries/client"
import auth from "@/lib/auth"
import useRefreshOnFocus from "@/queries/useRefreshOnFocus"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import { AnyDirEnumWithShareInfo, DirWithMetaEnum_Tags } from "@filen/sdk-rs"
import offline from "@/lib/offline"
import { unwrapDirMeta, unwrappedDirIntoDriveItem } from "@/lib/utils"

export const BASE_QUERY_KEY = "useDirectorySizeQuery"

export type UseDirectorySizeQueryParams = {
	uuid: string
	offline: boolean
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
	const dir = cache.directoryUuidToDir.get(params.uuid)
	const sharedDir = cache.sharedDirUuidToDir.get(params.uuid)

	if (params.offline) {
		if (dir) {
			return await offline.itemSize(unwrappedDirIntoDriveItem(unwrapDirMeta(dir)))
		}

		if (sharedDir) {
			return await offline.itemSize(unwrappedDirIntoDriveItem(unwrapDirMeta(sharedDir)))
		}

		return {
			size: 0,
			files: 0,
			dirs: 0
		}
	}

	const anyDir = (() => {
		if (sharedDir) {
			return sharedDir.dir.tag === DirWithMetaEnum_Tags.Dir
				? new AnyDirEnumWithShareInfo.SharedDir(sharedDir)
				: new AnyDirEnumWithShareInfo.Root(sharedDir.dir.inner[0])
		}

		if (dir) {
			return new AnyDirEnumWithShareInfo.Dir(dir)
		}

		return undefined
	})()

	if (!anyDir) {
		return {
			size: 0,
			files: 0,
			dirs: 0
		}
	}

	const { authedSdkClient } = await auth.getSdkClients()
	const { size, files, dirs } = await authedSdkClient.getDirSize(
		anyDir,
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
