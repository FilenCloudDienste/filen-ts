import { Fragment } from "react"
import { useTranslation } from "react-i18next"
import type { Chat } from "@filen/sdk-rs"
import { cn } from "@/lib/utils"
import { segmentMessage } from "@/features/chats/lib/regexed.logic"
import { contactDisplayName } from "@/features/contacts/components/contactsList.logic"

// Renders one message body from the pure segment list. Every branch emits a React text node or element —
// never parsed HTML, never dangerouslySetInnerHTML — so injection is structurally impossible (synthesis
// §3.5). Links are hardened at the segment layer (regexed.logic.hardenLinkHref) AND rendered with
// rel="noopener noreferrer nofollow" + target="_blank". Emoji shortcodes render as their literal text this
// wave (the custom emoji pack lands with the composer wave); the segment already exists so the image slots
// in later with no call-site change.
export function MessageContent({ chat, text }: { chat: Chat; text: string | undefined }) {
	const { t } = useTranslation("chats")
	const segments = segmentMessage(text)

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

					case "link":
						return (
							<a
								key={index}
								href={segment.href}
								target="_blank"
								rel="noopener noreferrer nofollow"
								className="text-primary underline underline-offset-2 hover:no-underline"
							>
								{segment.href}
							</a>
						)

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

					case "emoji":
						// Literal shortcode until the emoji pack lands (see file header).
						return <Fragment key={index}>:{segment.shortcode}:</Fragment>

					default:
						return null
				}
			})}
		</span>
	)
}
