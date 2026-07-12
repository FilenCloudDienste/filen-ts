import { Fragment } from "react"
import { useTranslation } from "react-i18next"
import type { Chat } from "@filen/sdk-rs"
import { cn } from "@/lib/utils"
import { segmentMessage, isEmojiOnly } from "@/features/chats/lib/regexed.logic"
import { emojiForShortcode, customEmojiImageForShortcode } from "@/features/chats/lib/emoji"
import { parseFilenPublicLink } from "@/features/chats/lib/embeds.logic"
import { TrustedExternalLink } from "@/features/chats/components/thread/trustedExternalLink"
import { contactDisplayName } from "@/features/contacts/components/contactsList.logic"

// Renders one message body from the pure segment list. Every branch emits a React text node or element —
// never parsed HTML, never dangerouslySetInnerHTML — so injection is structurally impossible.
// Links are hardened at the segment layer (regexed.logic.hardenLinkHref) AND rendered with
// rel="noopener noreferrer nofollow" + target="_blank". A genuinely EXTERNAL link (not this app's own
// public-link format) additionally routes through TrustedExternalLink — a one-time-per-domain trust
// confirmation before it's ever opened; a Filen link stays a plain anchor (same domain, resolved
// through the authenticated in-app client either way, never gated). Emoji shortcodes resolve to
// standard unicode glyphs first, then the bundled custom-pack image subset (emoji.ts); a shortcode that
// resolves to neither stays literal. A message whose entire (trimmed) body is emoji shortcodes renders
// them "jumbo" — larger glyphs/images and no surrounding text sizing — mirroring mobile's emojiSize
// heuristic (regexed.logic.ts's isEmojiOnly).
export function MessageContent({ chat, text }: { chat: Chat; text: string | undefined }) {
	const { t } = useTranslation("chats")
	const segments = segmentMessage(text)
	const jumbo = isEmojiOnly(text)

	if (segments.length === 0) {
		return null
	}

	return (
		<span className="text-sm break-words whitespace-pre-wrap text-foreground">
			{segments.map((segment, index) => {
				switch (segment.kind) {
					case "text":
						return <Fragment key={index}>{segment.value}</Fragment>

					case "linebreak":
						return <br key={index} />

					case "code":
						return (
							<code
								key={index}
								className="my-0.5 block rounded-md bg-muted px-2 py-1 font-mono text-xs whitespace-pre-wrap text-foreground"
							>
								{segment.code}
							</code>
						)

					case "link": {
						const linkClassName = "text-primary underline underline-offset-2 hover:no-underline"

						// A Filen public link is this app's own domain — no external-navigation trust gate,
						// same posture as the embed card below it (filenLinkCard.tsx) opens with.
						if (parseFilenPublicLink(segment.href) !== null) {
							return (
								<a
									key={index}
									href={segment.href}
									target="_blank"
									rel="noopener noreferrer nofollow"
									className={linkClassName}
								>
									{segment.href}
								</a>
							)
						}

						return (
							<TrustedExternalLink
								key={index}
								href={segment.href}
								className={linkClassName}
							/>
						)
					}

					case "mention": {
						const label = segment.everyone
							? t("chatMentionEveryone")
							: (() => {
									const participant =
										segment.email !== null ? chat.participants.find(p => p.email === segment.email) : undefined

									return participant !== undefined ? contactDisplayName(participant) : t("chatMentionUnknown")
								})()

						return (
							<span
								key={index}
								className={cn("rounded px-0.5 font-medium text-primary")}
							>
								@{label}
							</span>
						)
					}

					case "emoji": {
						// Resolve `:shortcode:` to a standard unicode glyph first, then the bundled custom-pack
						// image subset; a shortcode outside both (e.g. a custom-pack name outside the bundled
						// subset, or a peer's genuinely unknown one) falls back to its literal text.
						const glyph = emojiForShortcode(segment.shortcode)

						if (glyph !== undefined) {
							return (
								<span
									key={index}
									className={jumbo ? "text-3xl leading-none" : undefined}
								>
									{glyph}
								</span>
							)
						}

						const customImageUrl = customEmojiImageForShortcode(segment.shortcode)

						if (customImageUrl !== undefined) {
							return (
								<img
									key={index}
									src={customImageUrl}
									alt={`:${segment.shortcode}:`}
									className={cn("inline-block object-contain align-text-bottom", jumbo ? "size-8" : "size-5")}
								/>
							)
						}

						return <Fragment key={index}>:{segment.shortcode}:</Fragment>
					}

					default:
						return null
				}
			})}
		</span>
	)
}
