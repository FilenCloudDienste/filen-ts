import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import auth from "@/lib/auth"
import { sortParams, parseFilenPublicLink, run } from "@filen/utils"
import { safeParseUrl, extractLinks, getPreviewType } from "@/lib/utils"
import { MaybeEncryptedUniffi_Tags, type DirPublicInfo, type LinkedFile } from "@filen/sdk-rs"
import { Paths } from "expo-file-system"
import mimeTypes from "mime-types"

const MAX_FILE_SIZE_IMAGE = 32 * 1024 * 1024

async function fetchMetadata(url: string, signal: AbortSignal): Promise<Response | null> {
	try {
		const res = await fetch(url, {
			method: "HEAD",
			signal,
			redirect: "follow"
		})

		if (res.ok) {
			return res
		}
	} catch {
		if (signal.aborted) {
			return null
		}
	}

	const ctrl = new AbortController()

	signal?.addEventListener(
		"abort",
		() => {
			ctrl.abort()
		},
		{
			once: true
		}
	)

	try {
		const res = await fetch(url, {
			method: "GET",
			signal: ctrl.signal,
			redirect: "follow"
		})

		// We have status + headers at this point. Kill the body stream immediately.
		// React Native's fetch will keep buffering otherwise.
		queueMicrotask(() => {
			ctrl.abort()
		})

		if (!res.ok) {
			return null
		}

		return res
	} catch {
		return null
	}
}

type ProbeMediaResult =
	| {
			success: false
	  }
	| {
			success: true
			previewType: ReturnType<typeof getPreviewType>
			contentType: string
			size: number
			url: string
			name: string
	  }

export async function probeMedia(raw: string, signal?: AbortSignal): Promise<ProbeMediaResult> {
	const parsed = safeParseUrl(raw)

	if (!parsed) {
		return {
			success: false
		}
	}

	const ctrl = new AbortController()

	const timer = setTimeout(() => {
		ctrl.abort()
	}, 5000)

	signal?.addEventListener(
		"abort",
		() => {
			ctrl.abort()
		},
		{
			once: true
		}
	)

	const result = await run(async (defer): Promise<ProbeMediaResult> => {
		defer(() => {
			clearTimeout(timer)
		})

		const res = await fetchMetadata(parsed.href, ctrl.signal)

		if (!res) {
			return {
				success: false
			}
		}

		const safeUrl = safeParseUrl(res.url)

		if (!safeUrl) {
			return {
				success: false
			}
		}

		const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
		const lenHeader = res.headers.get("content-length")
		const size = lenHeader ? parseInt(lenHeader, 10) : undefined

		if (typeof size !== "number" || !isFinite(size) || size < 0 || typeof contentType !== "string" || contentType.length === 0) {
			return {
				success: false
			}
		}

		const ext = mimeTypes.extension(contentType)
		const name = `${Paths.parse(safeUrl.pathname).name}${ext ? `.${ext}` : ""}`
		const previewType = getPreviewType(name)

		if (previewType === "image" && size > MAX_FILE_SIZE_IMAGE) {
			return {
				success: false
			}
		}

		return {
			success: true,
			previewType,
			contentType,
			size,
			url: res.url,
			name
		}
	})

	if (!result.success) {
		return {
			success: false
		}
	}

	return result.data
}

export const BASE_QUERY_KEY = "useChatMessageLinksQuery"

export type useChatMessageLinksQueryParams = {
	links: ReturnType<typeof extractLinks>
}

export type LinkResult =
	| {
			type: "internal"
			success: false
	  }
	| {
			type: "external"
			success: false
	  }
	| {
			type: "internal"
			success: true
			data:
				| {
						type: "directory"
						info: DirPublicInfo
				  }
				| {
						type: "file"
						previewType: ReturnType<typeof getPreviewType>
						file: LinkedFile
						linkUuid: string
						fileKey: string
				  }
	  }
	| {
			type: "external"
			success: true
			data: Extract<
				ProbeMediaResult,
				{
					success: true
				}
			>
	  }

export async function fetchData(
	params: useChatMessageLinksQueryParams & {
		signal?: AbortSignal
	}
) {
	if (params.links.length === 0) {
		return []
	}

	const { authedSdkClient } = await auth.getSdkClients()

	const parsed = await Promise.allSettled<LinkResult>(
		params.links.map(async link => {
			const filenPublicLink = parseFilenPublicLink(link.url)

			if (filenPublicLink) {
				if (filenPublicLink.type === "directory") {
					const result = await run(async () => {
						return authedSdkClient.getDirPublicLinkInfo(
							filenPublicLink.uuid,
							filenPublicLink.key,
							params.signal
								? {
										signal: params.signal
									}
								: undefined
						)
					})

					if (!result.success) {
						return {
							type: "internal",
							success: false
						}
					}

					return {
						type: "internal",
						success: true,
						data: {
							type: "directory",
							info: result.data
						}
					}
				}

				const result = await run(async () => {
					return authedSdkClient.getLinkedFile(
						filenPublicLink.uuid,
						filenPublicLink.key,
						undefined,
						params.signal
							? {
									signal: params.signal
								}
							: undefined
					)
				})

				if (!result.success) {
					return {
						type: "internal",
						success: false
					}
				}

				const name =
					result.data.name.tag === MaybeEncryptedUniffi_Tags.Decrypted ? result.data.name.inner[0].toLowerCase().trim() : null
				const previewType = name ? getPreviewType(name) : ("unknown" satisfies ReturnType<typeof getPreviewType>)

				if (!name) {
					return {
						type: "internal",
						success: false
					}
				}

				if (previewType === "image" && Number(result.data.size) > MAX_FILE_SIZE_IMAGE) {
					return {
						type: "internal",
						success: false
					}
				}

				return {
					type: "internal",
					success: true,
					data: {
						type: "file",
						previewType,
						file: result.data,
						linkUuid: filenPublicLink.uuid,
						fileKey: filenPublicLink.key
					}
				}
			}

			const mediaInfo = await probeMedia(link.url, params.signal)

			if (!mediaInfo.success) {
				return {
					type: "external",
					success: false
				}
			}

			return {
				type: "external",
				success: true,
				data: mediaInfo
			}
		})
	)

	return parsed.filter(result => result.status === "fulfilled").map(result => result.value)
}

export function useChatMessageLinksQuery(
	params: useChatMessageLinksQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
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

export default useChatMessageLinksQuery
