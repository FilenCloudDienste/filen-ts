import { parsePublicLink } from "@/features/publicLinks/lib/format.logic"
import { segmentMessage } from "@filen/shared"
import { hardenLinkHref } from "@/features/chats/lib/regexed.logic"

// The ONE link-extraction path every embed-aware call site shares (MessageEmbeds' own render, the
// message-menu's "has an embed to disable" gate) — reuses chatMessageSegments's already-tokenized
// "link" segments rather than re-scanning the raw text with a second regex pass. A segment's raw match
// is hardened here (never validated upstream any more), and a rejected one is dropped — no plain-text
// fallback makes sense for an embed-link list.
export function extractMessageLinks(text: string | undefined): string[] {
	return segmentMessage(text)
		.filter((segment): segment is Extract<typeof segment, { kind: "link" }> => segment.kind === "link")
		.map(segment => hardenLinkHref(segment.raw))
		.filter((href): href is string => href !== null)
}

// EXACT embed scope: Filen public-link cards ONLY. Every other link, direct image/video urls included,
// stays a plain link: rendering third-party media would make the reader's browser fetch from an
// arbitrary host, disclosing their IP to whoever posted the link, and the CSP refuses those hosts anyway.
// This module is PURE (no network, no React) — the one async leg (Filen-link metadata read) lives in
// queries/chatMessageLinks.ts.

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

// Every UNIQUE, in-scope embed candidate for a message's link segments, capped and order-preserving
// (first occurrence wins on a repeated URL). Pure — callers feed it the urls extractMessageLinks
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
