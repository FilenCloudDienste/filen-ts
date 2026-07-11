import { Buffer } from "buffer"
import { FILE_PUBLIC_LINK_URL_PREFIX, DIRECTORY_PUBLIC_LINK_URL_PREFIX } from "@/features/drive/components/linkDialog.logic"
import { previewCategoryForName, HEIC_EXTENSIONS, extensionOf } from "@/features/drive/lib/preview.logic"
import { isAllowedInlineContentType } from "@/lib/sw/protocol"
import { segmentMessage } from "@/features/chats/lib/regexed.logic"

// The ONE link-extraction path every embed-aware call site shares (MessageEmbeds' own render, the
// message-menu's "has an embed to disable" gate) — reuses regexed.logic's already-tokenized "link"
// segments rather than re-scanning the raw text with a second regex pass.
export function extractMessageLinks(text: string | undefined): string[] {
	return segmentMessage(text)
		.filter((segment): segment is Extract<typeof segment, { kind: "link" }> => segment.kind === "link")
		.map(segment => segment.href)
}

// D2 EXACT scope: Filen public-link cards + direct image/video ONLY. No YouTube/X/OpenGraph — those
// need a CORS-proxy/oEmbed/OG-scrape path the wasm SDK has none of (00-SYNTHESIS.md §3.5/§5 Q2). This
// module is PURE (no network, no React) — the two async legs (Filen-link metadata read, direct-media
// content-type probe) live in queries/chatMessageLinks.ts, which calls back into these classifiers.

// ── Filen public-link recognition ───────────────────────────────────────────────────────────────
// Matches the EXACT shape drive/components/linkDialog.logic.ts's buildPublicLinkUrl produces — the
// single source of truth for what a link built by this app looks like (imported, not re-declared):
// `${PREFIX}${linkUuid}${"#"|"%23"}${hexEncodedKey}`. A plain prefix match (not a URL/hash re-parse)
// is deliberate: the prefix already pins scheme+host+route exactly, and the key segment can contain
// characters (`%23`) a naive `new URL().hash` re-split would need to re-decode anyway.
export interface FilenPublicLink {
	kind: "file" | "directory"
	linkUuid: string
	// The plaintext key (already hex-decoded) — what getLinkedFile/getDirPublicLinkInfo want, not the
	// hex the URL itself carries.
	key: string
}

const LINK_PREFIXES: readonly { prefix: string; kind: FilenPublicLink["kind"] }[] = [
	{ prefix: FILE_PUBLIC_LINK_URL_PREFIX, kind: "file" },
	{ prefix: DIRECTORY_PUBLIC_LINK_URL_PREFIX, kind: "directory" }
]

function hexDecode(hex: string): string | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
		return null
	}

	try {
		return Buffer.from(hex, "hex").toString("utf-8")
	} catch {
		return null
	}
}

export function parseFilenPublicLink(raw: string): FilenPublicLink | null {
	for (const { prefix, kind } of LINK_PREFIXES) {
		if (!raw.startsWith(prefix)) {
			continue
		}

		const rest = raw.slice(prefix.length)
		// The uuid never contains "#"/"%23" — the first occurrence of either is the separator the
		// builder inserted (encodeURIComponent("#") for a fresh link; a literal "#" for one built
		// before that encoding, or one re-typed by hand — accept both, mirrors the mobile parser's
		// own leniency, see this file's header comment).
		const literalIndex = rest.indexOf("#")
		const encodedIndex = rest.indexOf("%23")
		const sepIndex = literalIndex === -1 ? encodedIndex : encodedIndex === -1 ? literalIndex : Math.min(literalIndex, encodedIndex)

		if (sepIndex <= 0) {
			return null
		}

		const linkUuid = rest.slice(0, sepIndex)
		const sepLength = rest.startsWith("%23", sepIndex) ? 3 : 1
		const hexKey = rest.slice(sepIndex + sepLength)
		const key = hexDecode(hexKey)

		if (key === null) {
			return null
		}

		return { kind, linkUuid, key }
	}

	return null
}

// ── Direct media URL classification ─────────────────────────────────────────────────────────────
// Extension-first (previewCategoryForName — the SAME name-only classifier the external preview arm
// uses, features/drive/lib/preview.logic.ts), narrowed to image|video (D2 excludes audio/pdf/etc, and
// HEIC — no browser decodes it inline, needsImageTransform's rule ported name-only since there is no
// drive item here to check).
export type DirectMediaCategory = "image" | "video"

export function mediaCategoryFromUrl(raw: string): DirectMediaCategory | null {
	let parsed: URL

	try {
		parsed = new URL(raw)
	} catch {
		return null
	}

	const name = parsed.pathname.split("/").pop() ?? ""

	if (name.length === 0 || HEIC_EXTENSIONS.has(extensionOf(name))) {
		return null
	}

	const category = previewCategoryForName(name)

	return category === "image" || category === "video" ? category : null
}

// True for an https URL with no embedded credentials — the only scheme this app's own links or a
// pasted media URL should ever need, and the minimum bar before ANY fetch is attempted against it.
// NOT a private-IP/SSRF boundary (see this module's header + queries/chatMessageLinks.ts's probe
// comment for the honest browser posture) — a cheap, non-authoritative sanity gate only.
export function isEmbeddableHttpsUrl(raw: string): boolean {
	let parsed: URL

	try {
		parsed = new URL(raw)
	} catch {
		return false
	}

	return parsed.protocol === "https:" && parsed.username.length === 0 && parsed.password.length === 0
}

// One classified embed candidate for a single extracted link (regexed.logic's "link" segments are
// the caller's only source of urls — never raw message text re-scanned here). "none" means "render as
// a plain link, no embed" — the D2 out-of-scope case (YouTube/X/OG/anything else) collapses to this.
export type EmbedCandidate =
	| { kind: "filenLink"; url: string; link: FilenPublicLink }
	| { kind: "media"; url: string; category: DirectMediaCategory }
	| { kind: "none"; url: string }

// The renderable subset — every caller past classification itself (embedCandidatesForLinks' own
// return, and everything downstream: messageEmbeds.tsx, chatMessageLinks.ts) only ever sees these two
// arms, "none" already filtered. A dedicated type (not just EmbedCandidate[] with a runtime-only
// guarantee) so the renderer's kind-narrow doesn't need a dead, unreachable "none" arm to satisfy it.
export type RenderableEmbedCandidate = Exclude<EmbedCandidate, { kind: "none" }>

export function classifyEmbedUrl(url: string): EmbedCandidate {
	const filenLink = parseFilenPublicLink(url)

	if (filenLink !== null) {
		return { kind: "filenLink", url, link: filenLink }
	}

	if (!isEmbeddableHttpsUrl(url)) {
		return { kind: "none", url }
	}

	const category = mediaCategoryFromUrl(url)

	return category !== null ? { kind: "media", url, category } : { kind: "none", url }
}

// No explicit "embeds per message" cap was found in either source study (mobile's Attachments renders
// every resolved link with no slice; old-web's doc pass didn't surface one either) — this is a
// defensive UI bound this wave introduces, NOT a ported mobile constant. Applied by the caller
// (messageContent.tsx) after dedup, oldest-first (message order), so a message with many links still
// renders its first few embeds deterministically rather than silently degrading to zero.
export const MAX_MESSAGE_EMBEDS = 6

// Every UNIQUE, D2-in-scope embed candidate for a message's link segments, capped and order-preserving
// (first occurrence wins on a repeated URL). Pure — the caller (messageContent.tsx) feeds it the "link"
// segments regexed.logic.ts already extracted, so this never re-implements url extraction.
export function embedCandidatesForLinks(urls: readonly string[]): RenderableEmbedCandidate[] {
	const seen = new Set<string>()
	const candidates: RenderableEmbedCandidate[] = []

	for (const url of urls) {
		if (seen.has(url)) {
			continue
		}

		seen.add(url)

		const candidate = classifyEmbedUrl(url)

		if (candidate.kind === "none") {
			continue
		}

		candidates.push(candidate)

		if (candidates.length >= MAX_MESSAGE_EMBEDS) {
			break
		}
	}

	return candidates
}

// Content-type gate for the direct-media leg's probe result (queries/chatMessageLinks.ts calls this
// once it has a response Content-Type header) — reuses the SAME allowlist the drive inline-preview
// route enforces (lib/sw/protocol.ts), so a chat media embed can never stream a Content-Type the rest
// of the app wouldn't already trust inline. `category` cross-checks the header actually agrees with
// what the extension implied (an .mp4 URL serving `text/html` — an error page, a redirect-to-login —
// must NOT render as a video element).
export function contentTypeMatchesCategory(contentType: string, category: DirectMediaCategory): boolean {
	if (!isAllowedInlineContentType(contentType)) {
		return false
	}

	const normalized = contentType.toLowerCase().trim()

	return category === "image" ? normalized.startsWith("image/") : normalized.startsWith("video/")
}
