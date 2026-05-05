import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import * as MediaLibraryLegacy from "expo-media-library"
import * as ImagePicker from "expo-image-picker"

export const BASE_QUERY_KEY = "useMediaPermissionsQuery"

export async function fetchData() {
	const [mediaLibraryPermissions, cameraPermissions] = await Promise.all([
		MediaLibraryLegacy.getPermissionsAsync(),
		ImagePicker.getCameraPermissionsAsync()
	])

	return {
		mediaLibrary: mediaLibraryPermissions,
		camera: cameraPermissions
	}
}

export function useMediaPermissionsQuery(
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		queryKey: [BASE_QUERY_KEY],
		queryFn: () => fetchData()
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export function mediaPermissionsQueryUpdate({
	updater
}: {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
}) {
	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY], prev => {
		return typeof updater === "function" ? updater(prev as Awaited<ReturnType<typeof fetchData>>) : updater
	})
}

export function mediaPermissionsQueryGet() {
	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY])
}

export default useMediaPermissionsQuery
