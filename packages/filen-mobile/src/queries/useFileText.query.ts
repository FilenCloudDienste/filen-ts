import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import { sortParams } from "@filen/utils"
import { Buffer } from "react-native-quick-crypto"
import { type FileSource, resolveFile, fileSourceKey } from "@/queries/fileSource"

export const BASE_QUERY_KEY = "useFileTextQuery"

export type UseFileTextQueryParams = FileSource

export async function fetchData(
	params: UseFileTextQueryParams & {
		signal?: AbortSignal
	}
) {
	const file = await resolveFile(params, params.signal)

	// Not file.text(): that lets the OS pick the decoding — on iOS, NSString encoding
	// detection throws (Cocoa 264) for content it can't classify, e.g. binary bytes behind
	// a .txt name (macOS "._*" AppleDouble sidecars), surfacing a raw query error alert,
	// while Android decodes lossily. Decode UTF-8 with replacement characters ourselves so
	// both platforms behave like the web app: valid text is unchanged, undecodable input
	// yields U+FFFD and gets caught by the preview's isProbablyBinaryText gate.
	return Buffer.from(await file.bytes()).toString("utf8")
}

export function useFileTextQuery(
	params: UseFileTextQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		// File contents can be MB-sized; evict immediately when the last subscriber unmounts. fileCache backs us on disk, so refetch is cheap.
		gcTime: 0,
		...options,
		// Key off identity only (fileSourceKey strips the by-value item).
		queryKey: [BASE_QUERY_KEY, sortParams(fileSourceKey(params))],
		queryFn: ({ signal }) =>
			fetchData({
				...params,
				signal
			})
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export default useFileTextQuery
