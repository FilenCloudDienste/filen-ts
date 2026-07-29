import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import auth from "@/lib/auth"
import { sortParams, parseFilenPublicLink, run } from "@filen/utils"
import { getPreviewType } from "@/lib/previewType"
import { extractLinks } from "@/lib/linkParser"
import { MaybeEncryptedUniffi_Tags, type DirPublicInfo, type LinkedFile } from "@filen/sdk-rs"
import logger from "@/lib/logger"

const MAX_FILE_SIZE_IMAGE = 32 * 1024 * 1024

/**
 * What a rendered external link preview carries.
 *
 * Nothing populates this today — see the external branch of fetchData. It is kept because it is the
 * shape a proxied preview will produce, and because resolveLinkMedia and both attachment render
 * paths are written against it.
 */
export type ExternalLinkPreview = {
	previewType: ReturnType<typeof getPreviewType>
	contentType: string
	size: number
	url: string
	name: string
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
			data: ExternalLinkPreview
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

			// External links are NOT previewed, and this is the whole reason the branch exists.
			//
			// Generating one meant the RECIPIENT's device issuing a request to a host the SENDER chose,
			// at render time — including for rows FlashList mounts just off-screen, so before the
			// message was even on screen. That hands any sender an IP address, a rough location, a
			// User-Agent and the moment a chat was opened, from a message the recipient never
			// interacted with. No amount of URL vetting fixes that: the request itself is the leak.
			//
			// Filen public links above are unaffected — they resolve through the SDK against our own
			// API, which the client is already talking to. External URLs render as plain text and
			// contact nothing until the user taps one.
			//
			// Restore this when previews can be fetched by our infrastructure on the user's behalf, so
			// the origin sees our servers instead of the user. `ExternalLinkPreview` above and the
			// external arm of resolveLinkMedia are the shape that will carry it.
			return {
				type: "external",
				success: false
			}
		})
	)

	const rejected = parsed.filter(r => r.status === "rejected")

	if (rejected.length > 0) {
		logger.warn("chats", "Link preview fetch rejected", { count: rejected.length })
	}

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
