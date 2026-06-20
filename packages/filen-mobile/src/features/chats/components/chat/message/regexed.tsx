import { Fragment } from "react"
import regexifyString from "regexify-string"
import { Text } from "@/components/ui/text"
import View from "@/components/ui/view"
import { Platform } from "react-native"
import { customEmojis } from "@/assets/customEmojis"
import type { ChatParticipant } from "@filen/sdk-rs"
import { type Chat } from "@/types"
import useChatsStore, { type ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"
import Image from "@/components/ui/image"
import { useShallow } from "zustand/shallow"
import { PressableScale } from "@/components/ui/pressables"
import { contactDisplayName } from "@/lib/utils"
import { safeParseUrl, extractLinks } from "@/lib/linkParser"
import { cn, run } from "@filen/utils"
import * as Linking from "expo-linking"
import { useSecureStore } from "@/lib/secureStore"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import { URL_REGEX } from "@/constants"
import { useTranslation } from "react-i18next"
import logger from "@/lib/logger"

export const MENTION_REGEX: RegExp = /(@[\w.-]+@[\w.-]+\.\w+|@everyone)/g
export const LINE_BREAK_REGEX: RegExp = /\n/gi
export const CODE_REGEX: RegExp = /```([\s\S]*?)```/gi
export const EMOJI_REGEX_WITH_SKIN_TONES: RegExp = /:[\d+_a-z-]+(?:::skin-tone-\d+)?:/gi
export const MENTIONS: RegExp = /(@[\w.-]+@[\w.-]+\.\w+|@everyone)/gi
export const REGEX: RegExp = new RegExp(
	`${EMOJI_REGEX_WITH_SKIN_TONES.source}|${CODE_REGEX.source}|${URL_REGEX.source}|${MENTIONS.source}|${LINE_BREAK_REGEX.source}`
)

export const customEmojisSet = new Set(customEmojis.map(emoji => emoji.id))
export const customEmojisListRecord: Record<string, string> = Object.fromEntries(
	customEmojis.map(emoji => [emoji.id, emoji.skins[0] ? emoji.skins[0].src : ""])
)

const Mention = ({
	name,
	participant,
	inflight,
	fromSelf
}: {
	name: string
	participant?: ChatParticipant
	inflight?: boolean
	fromSelf?: boolean
}) => {
	const onPress = () => {
		if (!participant) {
			return
		}

		// TODO: profile popup
	}

	return (
		<PressableScale
			className="flex-row items-center shrink-0"
			rippleColor="transparent"
			onPress={onPress}
		>
			{/* Own bubbles are always blue regardless of theme — use a fixed light color, not the
			    theme `text-foreground` (which is dark in light mode → unreadable on blue). */}
			<Text className={cn("text-sm", fromSelf ? (inflight ? "text-gray-200" : "text-white") : inflight ? "text-muted-foreground" : "text-foreground")}>
				@{name}
			</Text>
		</PressableScale>
	)
}

const CodeBlock = ({ match, fromSelf }: { match: string; fromSelf: boolean }) => {
	const code = (() => {
		let code = match.split("```").join("").trim()

		while (code.startsWith("\n")) {
			code = code.slice(1, code.length)
		}

		while (code.endsWith("\n")) {
			code = code.slice(0, code.length - 1)
		}

		return code
	})()

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

export const Link = ({ match, fromSelf, inflight }: { match: string; fromSelf: boolean; inflight?: boolean }) => {
	const { t } = useTranslation()
	const [openLinkTrustedDomains, setOpenLinkTrustedDomains] = useSecureStore<Record<string, boolean>>("openLinkTrustedDomains", {})

	const parsedDomain = (() => {
		try {
			const url = new URL(match)

			return url.hostname
		} catch {
			return null
		}
	})()

	const onPress = async () => {
		if (!parsedDomain) {
			return
		}

		const canOpenResult = await run(async () => {
			return await Linking.canOpenURL(match)
		})

		if (!canOpenResult.success) {
			logger.error("chats", "canOpenURL check failed", { error: canOpenResult.error })
			alerts.error(canOpenResult.error)

			return
		}

		if (!canOpenResult.data) {
			alerts.error(t("cannot_open_link"))

			return
		}

		if (!openLinkTrustedDomains[parsedDomain]) {
			const promptResponse = await run(async () => {
				return await prompts.alert({
					title: t("open_external_link"),
					message: t("open_external_link_message", { domain: parsedDomain }),
					cancelText: t("cancel"),
					okText: t("open_trust")
				})
			})

			if (!promptResponse.success) {
				logger.error("chats", "open link confirmation prompt failed", { error: promptResponse.error })
				alerts.error(promptResponse.error)

				return
			}

			if (promptResponse.data.cancelled) {
				return
			}

			setOpenLinkTrustedDomains(prev => ({
				...prev,
				[parsedDomain]: true
			}))
		}

		const openResult = await run(async () => {
			return await Linking.openURL(match)
		})

		if (!openResult.success) {
			logger.error("chats", "openURL failed", { error: openResult.error })
			alerts.error(openResult.error)

			return
		}
	}

	if (!parsedDomain) {
		return match
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

	const replaced = (() => {
		if (!message.inner.message) {
			return []
		}

		const emojiCount = message.inner.message.match(EMOJI_REGEX_WITH_SKIN_TONES)
		let emojiSize: number | undefined = 32

		if (emojiCount) {
			const emojiCountJoined = emojiCount.join("")

			if (emojiCountJoined.length !== message.inner.message.trim().length) {
				emojiSize = 20
			}
		}

		const regexed = regexifyString({
			pattern: REGEX,
			decorator: match => {
				if (match.startsWith("@") && (match.split("@").length === 3 || match.startsWith("@everyone"))) {
					const email = match.slice(1).trim()

					if (email === "everyone") {
						return (
							<Mention
								name={t("everyone")}
								fromSelf={fromSelf}
							/>
						)
					}

					if (!email.includes("@")) {
						return (
							<Mention
								name={t("unknown")}
								fromSelf={fromSelf}
							/>
						)
					}

					const foundParticipant = chat.participants.find(p => p.email === email)

					if (!foundParticipant) {
						return (
							<Mention
								name={t("unknown")}
								fromSelf={fromSelf}
							/>
						)
					}

					return (
						<Mention
							name={contactDisplayName(foundParticipant)}
							participant={foundParticipant}
							fromSelf={fromSelf}
						/>
					)
				}

				if (match.split("```").length >= 3) {
					return (
						<CodeBlock
							match={match}
							fromSelf={fromSelf}
						/>
					)
				}

				if (match.startsWith("https://") && extractLinks(match).length === 1 && safeParseUrl(match)) {
					return (
						<Link
							match={match}
							fromSelf={fromSelf}
							inflight={isInflight}
						/>
					)
				}

				if (match.includes("\n")) {
					return <View className="flex-1 w-full h-2 basis-full shrink-0 bg-transparent" />
				}

				const customEmoji = match.split(":").join("").trim()

				if (customEmojisSet.has(customEmoji) && customEmojisListRecord[customEmoji]) {
					return (
						<Image
							cachePolicy="disk"
							contentFit="contain"
							style={{
								width: emojiSize,
								height: emojiSize
							}}
							source={{
								uri: customEmojisListRecord[customEmoji]
							}}
							className="shrink-0 bg-transparent"
							recyclingKey={`emoji-${customEmoji}-${emojiSize}`}
						/>
					)
				}

				return match
			},
			input: message.inner.message
		}) as (string | React.ReactElement)[]

		return regexed
	})()

	if (replaced.length === 0) {
		return null
	}

	return (
		<View className="flex-row flex-wrap text-wrap break-all items-center bg-transparent">
			{replaced.map((item, index) => {
				if (typeof item === "string") {
					if (item.length === 0) {
						return null
					}

					return (
						<Text
							key={index}
							className={cn(
								"text-sm shrink-0 flex-wrap text-wrap items-center break-all",
								fromSelf
									? isInflight
										? "text-gray-200"
										: "text-white"
									: isInflight
										? "text-muted-foreground"
										: "text-foreground"
							)}
						>
							{item}
						</Text>
					)
				}

				return <Fragment key={index}>{item}</Fragment>
			})}
		</View>
	)
}

export default Regexed
