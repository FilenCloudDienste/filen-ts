import { parseFilenPublicLink, type FilenPublicLink, type MessageSegment } from "@filen/shared"
import { hardenLinkHref } from "@/features/chats/lib/regexed.logic"

// The ONE link-extraction path (MessageRow derives the row's embeds from it once) — reads the row's
// already-tokenized "link" segments rather than re-scanning the raw text. A segment's raw match is
// hardened here (never validated upstream any more), and a rejected one is dropped — no plain-text
// fallback makes sense for an embed-link list.
export function linksFromSegments(segments: readonly MessageSegment[]): string[] {
	return segments
		.filter((segment): segment is Extract<typeof segment, { kind: "link" }> => segment.kind === "link")
		.map(segment => hardenLinkHref(segment.raw))
		.filter((href): href is string => href !== null)
}

// EXACT embed scope: Filen public-link cards ONLY. Every other link, direct image/video urls included,
// stays a plain link: rendering third-party media would make the reader's browser fetch from an
// arbitrary host, disclosing their IP to whoever posted the link, and the CSP refuses those hosts anyway.
// This module is PURE (no network, no React) — the one async leg (Filen-link metadata read) lives in
// queries/chatMessageLinks.ts.

// One embed candidate for a single extracted link (chatMessageSegments's "link" segments are the
// caller's only source of urls — never raw message text re-scanned here).
export interface EmbedCandidate {
	kind: "filenLink"
	url: string
	link: FilenPublicLink
}

// No explicit "embeds per message" cap exists on either reference client (mobile's Attachments renders
// every resolved link with no cap; old-web has none either) — this is a
// defensive UI bound this codebase introduces, NOT a ported mobile constant. Applied below after dedup,
// oldest-first (message order), so a message with many links still renders its first few embeds
// deterministically rather than silently degrading to zero.
export const MAX_MESSAGE_EMBEDS = 6

// Largest linked image a message inlines: a bigger one is a click-to-preview card, so a message of huge
// image links never streams and decodes them for every reader who scrolls past. Generous enough for
// ordinary phone photos. A byte cap does not bound decoded dimensions. Video and audio inline at any size:
// their elements fetch metadata only.
export const MAX_INLINE_EMBED_IMAGE_BYTES = 32 * 1024 * 1024

export function inlinesEmbedImage(size: number): boolean {
	return size <= MAX_INLINE_EMBED_IMAGE_BYTES
}

// Every UNIQUE, in-scope embed candidate for a message's link segments, capped and order-preserving
// (first occurrence wins on a repeated URL). Pure — callers feed it the urls linksFromSegments
// already extracted and hardened, so this never re-implements url extraction or hardening.
export function embedCandidatesForLinks(urls: readonly string[]): EmbedCandidate[] {
	const seen = new Set<string>()
	const candidates: EmbedCandidate[] = []

	for (const url of urls) {
		if (seen.has(url)) {
			continue
		}

		seen.add(url)

		const link = parseFilenPublicLink(url)

		if (link === null) {
			continue
		}

		candidates.push({ kind: "filenLink", url, link })

		if (candidates.length >= MAX_MESSAGE_EMBEDS) {
			break
		}
	}

	return candidates
}

export interface EmbedMediaSize {
	width: number
	height: number
}

// The inline image/video frame's bounds in CSS px. A frame never shrinks below the minimum edge, so a tiny or
// extreme-aspect file still gets a box its rounded-2xl corners fit.
export const EMBED_MEDIA_MAX_WIDTH = 384
export const EMBED_MEDIA_MAX_HEIGHT = 288
export const EMBED_MEDIA_MIN_EDGE = 48

// Reserved while the media's own dimensions are unknown: neither the link metadata nor the message carries
// them, so the first load is the only point they become known.
export const EMBED_MEDIA_PLACEHOLDER: EmbedMediaSize = { width: 256, height: 160 }

// The frame an inline image/video embed renders in: its natural size scaled down (never up) to fit the
// bounds, aspect kept, each edge clamped to the minimum. The frame IS the rounded clip box and the media
// fills it, so no media edge can sit inside or outside the rounded corners. A clamped edge (a tiny or
// extreme-aspect file) letterboxes on the frame's own background instead.
export function embedMediaFrame(natural: EmbedMediaSize | null): EmbedMediaSize {
	if (natural === null || !(natural.width > 0) || !(natural.height > 0) || !Number.isFinite(natural.width + natural.height)) {
		return EMBED_MEDIA_PLACEHOLDER
	}

	const scale = Math.min(1, EMBED_MEDIA_MAX_WIDTH / natural.width, EMBED_MEDIA_MAX_HEIGHT / natural.height)

	return {
		width: Math.min(EMBED_MEDIA_MAX_WIDTH, Math.max(EMBED_MEDIA_MIN_EDGE, Math.round(natural.width * scale))),
		height: Math.min(EMBED_MEDIA_MAX_HEIGHT, Math.max(EMBED_MEDIA_MIN_EDGE, Math.round(natural.height * scale)))
	}
}

// Natural sizes already seen, by linked-file uuid, so a row the virtualized thread remounts (or a second
// message with the same link) reserves its final frame at once instead of reflowing from the placeholder.
// Bounded, oldest entry out first. The one piece of module state here.
const MAX_REMEMBERED_MEDIA_SIZES = 256
const rememberedMediaSizes = new Map<string, EmbedMediaSize>()

export function rememberedEmbedMediaSize(uuid: string): EmbedMediaSize | null {
	return rememberedMediaSizes.get(uuid) ?? null
}

export function rememberEmbedMediaSize(uuid: string, size: EmbedMediaSize): void {
	rememberedMediaSizes.delete(uuid)
	rememberedMediaSizes.set(uuid, size)

	if (rememberedMediaSizes.size > MAX_REMEMBERED_MEDIA_SIZES) {
		const oldest = rememberedMediaSizes.keys().next()

		if (oldest.done !== true) {
			rememberedMediaSizes.delete(oldest.value)
		}
	}
}
