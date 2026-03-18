import { parseBuffer } from "music-metadata"
import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS_ETERNAL, useDefaultQueryParams } from "@/queries/client"
import { sortParams } from "@filen/utils"
import { Buffer } from "react-native-quick-crypto"
import { Image, type ImageRef } from "expo-image"
import { fetch } from "expo/fetch"

export const BASE_QUERY_KEY = "useAudioMetadataQuery"

export type UseAudioMetadataQueryParams = {
	url: string
}

export async function fetchData(
	params: UseAudioMetadataQueryParams & {
		signal?: AbortSignal
	}
) {
	const response = await fetch(params.url, {
		signal: params.signal
	})

	if (!response.ok) {
		throw new Error(`Failed to fetch audio file: ${response.status} ${response.statusText}`)
	}

	const contentLength = response.headers.get("Content-Length") ?? response.headers.get("content-length")
	const size = contentLength ? parseInt(contentLength, 10) : undefined
	const mimeType = response.headers.get("Content-Type") ?? response.headers.get("content-type")

	if (!mimeType) {
		throw new Error("Content-Type header is missing in the response")
	}

	if (!size) {
		throw new Error("Content-Length header is missing in the response")
	}

	// TODO: Could also consider stream parsing
	const metadata = await parseBuffer(new Uint8Array(await response.arrayBuffer()), {
		mimeType,
		size
	})

	const picture = metadata?.common?.picture?.at(0)
	const pictureBase64 = picture ? `data:${picture.format};base64,${Buffer.from(picture.data).toString("base64")}` : null
	let pictureBlurhash: string | null = null

	if (pictureBase64) {
		let image: ImageRef | null = null

		try {
			image = await Image.loadAsync(pictureBase64)
			pictureBlurhash = await Image.generateBlurhashAsync(image, [4, 3])
		} catch (e) {
			console.error(e)
		} finally {
			if (image) {
				image.release()

				image = null
			}
		}
	}

	return {
		pictureBase64,
		pictureBlurhash,
		artist: metadata?.common?.artist ?? null,
		title: metadata?.common?.title ?? null,
		album: metadata?.common?.album ?? null,
		d: metadata?.common?.date ?? null,
		duration: metadata?.format?.duration ? Math.round(metadata.format.duration) : null
	}
}

export function useAudioMetadataQuery(
	params: UseAudioMetadataQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const defaultParams = useDefaultQueryParams(options)
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS_ETERNAL,
		...defaultParams,
		...options,
		queryKey: [BASE_QUERY_KEY, sortedParams],
		queryFn: ({ signal }) =>
			fetchData({
				...sortedParams,
				signal
			})
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export default useAudioMetadataQuery
