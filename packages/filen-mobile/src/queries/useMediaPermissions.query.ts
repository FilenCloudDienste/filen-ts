import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import * as MediaLibraryLegacy from "expo-media-library/legacy"
import * as ImagePicker from "expo-image-picker"

export const BASE_QUERY_KEY = "useMediaPermissionsQuery"

export async function fetchData(_signal?: AbortSignal) {
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
		queryFn: ({ signal }) => fetchData(signal)
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export default useMediaPermissionsQuery
