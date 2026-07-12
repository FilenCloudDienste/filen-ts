import { parsePublicLink } from "@/features/publicLinks/lib/format.logic"
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

// EXACT embed scope: Filen public-link cards + direct image/video ONLY. No YouTube/X/OpenGraph — those
// need a CORS-proxy/oEmbed/OG-scrape path the wasm SDK has none of. This
// module is PURE (no network, no React) — the two async legs (Filen-link metadata read, direct-media
// content-type probe) live in queries/chatMessageLinks.ts, which calls back into these classifiers.

// ── Filen public-link recognition ───────────────────────────────────────────────────────────────
// Thin adapter over the shared recognizer (features/publicLinks/lib/format.logic.ts — the ONE place
// both the link builder and every parser agree on the URL shape). That recognizer classifies BOTH
// the NEW path-based format this app now emits AND the LEGACY hash-router format (letters swapped
// between eras), so a link pasted in chat under either era renders as a rich card rather than falling
// through to the generic external-link path. This shape (`linkUuid`, not `uuid`) is kept for the chat
// consumers that already read it (chatMessageLinks.ts, filenLinkCard.tsx).
export interface FilenPublicLink {
	kind: "file" | "directory"
	linkUuid: string
	// The plaintext key (already hex-decoded) — what getLinkedFile/getDirPublicLinkInfo want, not the
	// hex the URL itself carries.
	key: string
}

export function parseFilenPublicLink(raw: string): FilenPublicLink | null {
	const target = parsePublicLink(raw)

	return target === null ? null : { kind: target.kind, linkUuid: target.uuid, key: target.key }
}

// ── Direct media URL classification ─────────────────────────────────────────────────────────────
// Extension-first (previewCategoryForName — the SAME name-only classifier the external preview arm
// uses, features/drive/lib/preview.logic.ts), narrowed to image|video (out of scope for audio/pdf/etc, and
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
// a plain link, no embed" — the out-of-scope case (YouTube/X/OG/anything else) collapses to this.
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

// No explicit "embeds per message" cap exists on either reference client (mobile's Attachments renders
// every resolved link with no cap; old-web has none either) — this is a
// defensive UI bound this codebase introduces, NOT a ported mobile constant. Applied by the caller
// (messageContent.tsx) after dedup, oldest-first (message order), so a message with many links still
// renders its first few embeds deterministically rather than silently degrading to zero.
export const MAX_MESSAGE_EMBEDS = 6

// Every UNIQUE, in-scope embed candidate for a message's link segments, capped and order-preserving
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
