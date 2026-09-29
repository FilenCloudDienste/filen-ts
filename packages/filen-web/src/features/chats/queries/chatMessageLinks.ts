import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import type { LinkedFile } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { linkedFileIntoDriveItem } from "@/features/drive/lib/item"
import { previewType, type PreviewCategory } from "@/features/drive/lib/preview.logic"
import type { FilenPublicLink } from "@filen/shared"
import { embedCandidatesForLinks } from "@/features/chats/lib/embeds.logic"

// Per-message embed resolution — the async leg behind embeds.logic.ts's pure classification, which
// only ever yields Filen public links. Each is a metadata-only read (the worker's getLinkedFileAnon /
// getDirPublicLinkInfoAnon) — the SAME round trip opening the link in a browser would make, and it goes
// to Filen's own API, never to a host the sender picked. A password-protected link or a resolution
// failure both degrade to `success: false` — there is no in-chat password prompt
// (FilenLinkCard then renders from the URL's own uuid, no network-derived name/icon). Nothing here ever
// fetches a third-party url: that would hand the reader's IP to whoever posted the link.

export type ChatLinkResolution =
	| { url: string; kind: "filenLink"; link: FilenPublicLink; success: false }
	| {
			url: string
			kind: "filenLink"
			link: FilenPublicLink
			success: true
			data:
				| {
						type: "file"
						name: string | null
						size: bigint
						// The resolved LinkedFile itself, plus the FULL previewType category it maps to via
						// linkedFileIntoDriveItem (item.ts) — the renderer feeds the SAME fabricated item into
						// PreviewOverlay to actually preview it, so this resolves the category from
						// that identical adapter output (extension-first, mime-fallback) rather than a second,
						// possibly-diverging classification.
						previewCategory: PreviewCategory
						linkedFile: LinkedFile
				  }
				| { type: "directory"; name: string | null; timestamp: bigint }
	  }

// `MaybeEncrypted<string>` narrow, local rather than reusing socket.ts's decryptedOrSkip: that helper
// logs under the "socket" category unconditionally, which would mislabel a link-resolution warning —
// this path degrades silently to the URL-parts-only fallback instead (FilenLinkCard's own concern).
function decryptedName(name: { Decrypted: string } | { Encrypted: unknown }): string | null {
	return "Decrypted" in name ? name.Decrypted : null
}

type ResolvedFilenLinkData = Extract<ChatLinkResolution, { success: true }>["data"]

async function resolveFilenLinkData(link: FilenPublicLink): Promise<ResolvedFilenLinkData | null> {
	try {
		if (link.type === "file") {
			const file = await sdkApi.getLinkedFileAnon(link.uuid, link.key)

			return {
				type: "file",
				name: decryptedName(file.name),
				size: file.size,
				previewCategory: previewType(linkedFileIntoDriveItem(file)),
				linkedFile: file
			}
		}

		const info = await sdkApi.getDirPublicLinkInfoAnon(link.uuid, link.key)
		const meta = info.root.inner.meta

		return {
			type: "directory",
			name: meta.type === "decoded" ? meta.data.name : null,
			// A decoded dir's own optional `created` wins; otherwise the root's raw upload timestamp —
			// mirrors formatCreatedDate's identical created-or-timestamp fallback (drive/lib/format.ts).
			timestamp: (meta.type === "decoded" ? meta.data.created : undefined) ?? info.root.inner.timestamp
		}
	} catch {
		return null
	}
}

export function chatMessageLinksQueryKey(urls: readonly string[]) {
	return ["chats", "links", { urls }] as const
}

export async function fetchChatMessageLinks(urls: readonly string[]): Promise<ChatLinkResolution[]> {
	return Promise.all(
		embedCandidatesForLinks(urls).map(async (candidate): Promise<ChatLinkResolution> => {
			const data = await resolveFilenLinkData(candidate.link)

			return data !== null
				? { url: candidate.url, kind: "filenLink", link: candidate.link, success: true, data }
				: { url: candidate.url, kind: "filenLink", link: candidate.link, success: false }
		})
	)
}

// The thread virtualizer remounts a row each time it scrolls back into view, and nothing (socket or
// mutation) ever patches this key, so staleTime 0 would re-resolve every link on each pass. Finite so
// a revoked or re-passworded link still surfaces eventually.
export const CHAT_MESSAGE_LINKS_STALE_TIME = 60 * 60 * 1000
// A failed resolution can be a network blip, so it retries sooner; still long enough that scrolling
// past a dead or password-protected link doesn't loop.
export const CHAT_MESSAGE_LINKS_FAILED_STALE_TIME = 5 * 60 * 1000

export function useChatMessageLinksQuery(urls: readonly string[]): UseQueryResult<ChatLinkResolution[]> {
	return useQuery({
		queryKey: chatMessageLinksQueryKey(urls),
		queryFn: () => fetchChatMessageLinks(urls),
		enabled: urls.length > 0,
		staleTime: query =>
			query.state.data?.some(result => !result.success) ? CHAT_MESSAGE_LINKS_FAILED_STALE_TIME : CHAT_MESSAGE_LINKS_STALE_TIME
	})
}
