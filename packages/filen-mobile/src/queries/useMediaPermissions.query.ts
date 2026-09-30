import { useQuery, type UseQueryResult } from "@tanstack/react-query"
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

export function useMediaPermissionsQuery(): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery<Awaited<ReturnType<typeof fetchData>>, Error>({
		queryKey: [BASE_QUERY_KEY],
		queryFn: ({ signal }) => fetchData(signal)
	})

	return query
}

export default useMediaPermissionsQuery
