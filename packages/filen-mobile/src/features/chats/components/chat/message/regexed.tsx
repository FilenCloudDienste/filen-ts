import { Text } from "@/components/ui/text"
import View from "@/components/ui/view"
import { Platform } from "react-native"
import { CUSTOM_EMOJI_PACK } from "@filen/shared/emojis"
import { type Chat } from "@/types"
import useChatsStore, { type ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"
import Image from "@/components/ui/image"
import { useShallow } from "zustand/shallow"
import { PressableScale } from "@/components/ui/pressables"
import { safeParseUrl, extractLinks } from "@/lib/linkParser"
import { cn, contactDisplayName, segmentMessage, isEmojiOnly } from "@filen/shared"
import useOpenExternalLink from "@/hooks/useOpenExternalLink"
import { useTranslation } from "react-i18next"
import logger from "@/lib/logger"

export const customEmojiSrcById = new Map<string, string>()

for (const emoji of CUSTOM_EMOJI_PACK) {
	const src = emoji.skins[0]?.src

	if (src) {
		customEmojiSrcById.set(emoji.id, src)
	}
}

// Own bubbles are blue in both themes, so their text is a fixed white rather than the theme
// `text-foreground` (dark in light mode, unreadable on blue).
const Mention = ({ name, fromSelf }: { name: string; fromSelf: boolean }) => {
	return <Text className={cn("text-sm shrink-0", fromSelf ? "text-white" : "text-foreground")}>@{name}</Text>
}

const CodeBlock = ({ code, fromSelf }: { code: string; fromSelf: boolean }) => {
	return (
		<View className={cn("flex-1 rounded-lg basis-full p-2 shrink-0", fromSelf ? "bg-blue-600" : "bg-background-tertiary")}>
			<Text
				className={cn("text-xs", fromSelf ? "text-white" : "text-muted-foreground")}
				style={{
					fontFamily: Platform.select({
						ios: "Menlo",
						android: "monospace"
					})
				}}
			>
				{code}
			</Text>
		</View>
	)
}

const Link = ({ match, fromSelf, inflight }: { match: string; fromSelf: boolean; inflight?: boolean }) => {
	// Chat messages come from another user, so their links go through the app's single funnel for
	// untrusted links (scheme allowlist -> https/private-host check -> trusted-domain prompt) rather
	// than a local copy of it. This used to be an inline duplicate that also hard-coded the trust
	// store's key, so a rename would have silently forked the remembered domains.
	const openExternalLink = useOpenExternalLink("chats")

	const onPress = () => {
		openExternalLink(match).catch(err => {
			logger.error("chats", "failed to open a message link", { error: err })
		})
	}

	return (
		<PressableScale
			className="flex-row items-center shrink-0"
			rippleColor="transparent"
			onPress={onPress}
		>
			{/* Own bubbles are blue in both themes — links there must be light (white), not the
			    theme `text-foreground` (dark in light mode → invisible on blue). Others' bubbles use
			    the theme background, so a blue link reads fine in both modes. */}
			<Text className={cn("underline", fromSelf ? (inflight ? "text-gray-200" : "text-white") : inflight ? "text-muted-foreground" : "text-blue-500")}>
				{match}
			</Text>
		</PressableScale>
	)
}

const Regexed = ({ chat, message, fromSelf }: { chat: Chat; message: ChatMessageWithInflightId; fromSelf: boolean }) => {
	const { t } = useTranslation()
	const isInflight = useChatsStore(
		useShallow(state => state.inflightMessages[chat.uuid]?.messages.some(m => m.inflightId === message.inflightId))
	)

	const segments = segmentMessage(message.inner.message)
	// isEmojiOnly(text) replaces the old inverted default (jumbo unless mixed content) — equivalent,
	// since the old default only ever mattered while at least one emoji was present.
	const emojiSize = isEmojiOnly(message.inner.message) ? 32 : 20

	if (segments.length === 0) {
		return null
	}

	const plainTextClassName = cn(
		"text-sm shrink-0 flex-wrap text-wrap items-center break-all",
		fromSelf ? (isInflight ? "text-gray-200" : "text-white") : isInflight ? "text-muted-foreground" : "text-foreground"
	)

	return (
		<View className="flex-row flex-wrap text-wrap break-all items-center bg-transparent">
			{segments.map((segment, index) => {
				switch (segment.kind) {
					case "text": {
						if (segment.value.length === 0) {
							return null
						}

						return (
							<Text
								key={index}
								className={plainTextClassName}
							>
								{segment.value}
							</Text>
						)
					}

					case "linebreak":
						return (
							<View
								key={index}
								className="flex-1 w-full h-2 basis-full shrink-0 bg-transparent"
							/>
						)

					case "code":
						return (
							<CodeBlock
								key={index}
								code={segment.code}
								fromSelf={fromSelf}
							/>
						)

					case "link": {
						// Segments carry the raw matched string, unvalidated — mobile's own single link
						// funnel decides eligibility (https-only, exactly one sub-link, safe-parseable),
						// same gate the pre-rewrite decorator applied inline.
						if (segment.raw.startsWith("https://") && extractLinks(segment.raw).length === 1 && safeParseUrl(segment.raw)) {
							return (
								<Link
									key={index}
									match={segment.raw}
									fromSelf={fromSelf}
									inflight={isInflight}
								/>
							)
						}

						return (
							<Text
								key={index}
								className={plainTextClassName}
							>
								{segment.raw}
							</Text>
						)
					}

					case "mention": {
						if (segment.everyone) {
							return (
								<Mention
									key={index}
									name={t("everyone")}
									fromSelf={fromSelf}
								/>
							)
						}

						if (segment.email === null) {
							return (
								<Mention
									key={index}
									name={t("unknown")}
									fromSelf={fromSelf}
								/>
							)
						}

						const foundParticipant = chat.participants.find(p => p.email === segment.email)

						// The mention text is the email itself — render it rather than "unknown" so
						// mentions of users who since left the chat stay attributable.
						return (
							<Mention
								key={index}
								name={foundParticipant ? contactDisplayName(foundParticipant) : segment.email}
								fromSelf={fromSelf}
							/>
						)
					}

					case "emoji": {
						const emojiSrc = customEmojiSrcById.get(segment.shortcode)

						if (emojiSrc) {
							return (
								<Image
									key={index}
									cachePolicy="disk"
									contentFit="contain"
									style={{
										width: emojiSize,
										height: emojiSize
									}}
									source={{
										uri: emojiSrc
									}}
									className="shrink-0 bg-transparent"
									recyclingKey={`emoji-${segment.shortcode}-${emojiSize}`}
								/>
							)
						}

						return (
							<Text
								key={index}
								className={plainTextClassName}
							>
								{segment.raw}
							</Text>
						)
					}

					default:
						return null
				}
			})}
		</View>
	)
}

export default Regexed
