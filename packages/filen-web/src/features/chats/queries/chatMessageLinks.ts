import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import {
	embedCandidatesForLinks,
	contentTypeMatchesCategory,
	type FilenPublicLink,
	type DirectMediaCategory
} from "@/features/chats/lib/embeds.logic"

// Per-message embed resolution — the async leg behind embeds.logic.ts's pure classification. Two
// independent resolution paths, matched to the two D2-in-scope embed kinds:
//   - filenLink: a metadata-only read against the wasm surface (getLinkedFile / getDirPublicLinkInfo)
//     — the SAME round trip opening the link in a browser would make, scoped to what this app itself
//     already exposes (sdk.worker.ts). A password-protected link or a resolution failure both degrade
//     to `success: false` — there is no in-chat password prompt this wave (FilenLinkCard then renders
//     from the URL's own uuid, no network-derived name/icon).
//   - media: a browser-side content-type PROBE, not a decrypted read — SSRF posture (re-audited for
//     the browser, synthesis §3.5): `mode:"cors"` + `credentials:"omit"` + https-only (embeds.logic.ts's
//     isEmbeddableHttpsUrl) are the REAL boundary here, not a manual IP/redirect check — a target with
//     no CORS headers fails this probe outright (opaque response, unreadable), which is the common case
//     for most third-party image/video hosts and is treated the SAME as any other resolution failure:
//     degrade to the plain link already inline in the message text (MessageContent renders it
//     regardless of embed success — see messageContent.tsx). Unlike mobile's RN `probeMedia`, this
//     deliberately does NOT fall back HEAD→GET on failure: a host that blocks a CORS HEAD blocks a CORS
//     GET identically, so the fallback would only cost a second round trip for the same negative
//     result. `redirect: "follow"` (fetch's default) is fine — the final response still has to clear
//     this same CORS gate to be readable at all, so a redirect can't be used to smuggle a non-CORS body
//     past this check.

export type ChatLinkResolution =
	| { url: string; kind: "filenLink"; link: FilenPublicLink; success: false }
	| {
			url: string
			kind: "filenLink"
			link: FilenPublicLink
			success: true
			data: { type: "file"; name: string | null; size: bigint } | { type: "directory"; name: string | null }
	  }
	| { url: string; kind: "media"; category: DirectMediaCategory; success: false }
	| { url: string; kind: "media"; category: DirectMediaCategory; success: true; contentType: string }

const PROBE_TIMEOUT_MS = 5_000

async function probeContentType(url: string, signal: AbortSignal | undefined): Promise<string | null> {
	const controller = new AbortController()
	const timer = setTimeout(() => {
		controller.abort()
	}, PROBE_TIMEOUT_MS)
	const forwardAbort = () => {
		controller.abort()
	}
	signal?.addEventListener("abort", forwardAbort, { once: true })

	try {
		const res = await fetch(url, { method: "HEAD", mode: "cors", credentials: "omit", signal: controller.signal })

		if (!res.ok) {
			return null
		}

		const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? ""

		return contentType.length > 0 ? contentType : null
	} catch {
		// CORS block, network error, timeout — all indistinguishable from here, all resolve the same
		// way: no embed, the plain link stands.
		return null
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener("abort", forwardAbort)
	}
}

// `MaybeEncrypted<string>` narrow, local rather than reusing socket.ts's decryptedOrSkip: that helper
// logs under the "socket" category unconditionally, which would mislabel a link-resolution warning —
// this path degrades silently to the URL-parts-only fallback instead (FilenLinkCard's own concern).
function decryptedName(name: { Decrypted: string } | { Encrypted: unknown }): string | null {
	return "Decrypted" in name ? name.Decrypted : null
}

async function resolveFilenLinkData(
	link: FilenPublicLink
): Promise<{ type: "file"; name: string | null; size: bigint } | { type: "directory"; name: string | null } | null> {
	try {
		if (link.kind === "file") {
			const file = await sdkApi.getLinkedFile(link.linkUuid, link.key)

			return { type: "file", name: decryptedName(file.name), size: file.size }
		}

		const info = await sdkApi.getDirPublicLinkInfo(link.linkUuid, link.key)
		const meta = info.root.inner.meta

		return { type: "directory", name: meta.type === "decoded" ? meta.data.name : null }
	} catch {
		return null
	}
}

export function chatMessageLinksQueryKey(urls: readonly string[]) {
	return ["chats", "links", { urls }] as const
}

export async function fetchChatMessageLinks(urls: readonly string[], signal?: AbortSignal): Promise<ChatLinkResolution[]> {
	const candidates = embedCandidatesForLinks(urls)

	const settled = await Promise.allSettled(
		candidates.map(async (candidate): Promise<ChatLinkResolution> => {
			if (candidate.kind === "filenLink") {
				const data = await resolveFilenLinkData(candidate.link)

				return data !== null
					? { url: candidate.url, kind: "filenLink", link: candidate.link, success: true, data }
					: { url: candidate.url, kind: "filenLink", link: candidate.link, success: false }
			}

			const contentType = await probeContentType(candidate.url, signal)

			if (contentType !== null && contentTypeMatchesCategory(contentType, candidate.category)) {
				return { url: candidate.url, kind: "media", category: candidate.category, success: true, contentType }
			}

			return { url: candidate.url, kind: "media", category: candidate.category, success: false }
		})
	)

	return settled.filter(result => result.status === "fulfilled").map(result => result.value)
}

export function useChatMessageLinksQuery(urls: readonly string[]): UseQueryResult<ChatLinkResolution[]> {
	return useQuery({
		queryKey: chatMessageLinksQueryKey(urls),
		queryFn: ({ signal }) => fetchChatMessageLinks(urls, signal),
		enabled: urls.length > 0
	})
}
