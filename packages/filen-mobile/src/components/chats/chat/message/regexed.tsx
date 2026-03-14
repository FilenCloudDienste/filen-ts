import { Fragment } from "react"
import { memo, useMemo, useCallback } from "@/lib/memo"
import regexifyString from "regexify-string"
import { Text } from "@/components/ui/text"
import View from "@/components/ui/view"
import { Platform } from "react-native"
import { customEmojis } from "@/assets/customEmojis"
import type { Chat, ChatParticipant } from "@filen/sdk-rs"
import useChatsStore, { type ChatMessageWithInflightId } from "@/stores/useChats.store"
import Image from "@/components/ui/image"
import isEqual from "react-fast-compare"
import { useShallow } from "zustand/shallow"
import { PressableScale } from "@/components/ui/pressables"
import { contactDisplayName } from "@/lib/utils"
import { cn, run } from "@filen/utils"
import * as Linking from "expo-linking"
import { useSecureStore } from "@/lib/secureStore"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"

export const MENTION_REGEX: RegExp = /(@[\w.-]+@[\w.-]+\.\w+|@everyone)/g
export const LINE_BREAK_REGEX: RegExp = /\n/gi
export const CODE_REGEX: RegExp = /```([\s\S]*?)```/gi
export const URL_REGEX: RegExp =
	/https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,64}\b(?:[-a-zA-Z0-9()@:%_+.~#?&//=]*)/gi
export const EMOJI_REGEX_WITH_SKIN_TONES: RegExp = /:[\d+_a-z-]+(?:::skin-tone-\d+)?:/gi
export const MENTIONS: RegExp = /(@[\w.-]+@[\w.-]+\.\w+|@everyone)/gi
export const REGEX: RegExp = new RegExp(
	`${EMOJI_REGEX_WITH_SKIN_TONES.source}|${CODE_REGEX.source}|${URL_REGEX.source}|${MENTIONS.source}|${LINE_BREAK_REGEX.source}`
)

export const customEmojisSet = new Set(customEmojis.map(emoji => emoji.id))
export const customEmojisListRecord: Record<string, string> = Object.fromEntries(
	customEmojis.map(emoji => [emoji.id, emoji.skins[0] ? emoji.skins[0].src : ""])
)

export const Mention = memo(
	({ name, participant, inflight }: { name: string; participant?: ChatParticipant; inflight?: boolean }) => {
		const onPress = useCallback(() => {
			if (!participant) {
				return
			}

			// TODO: profile popup
		}, [participant])

		return (
			<PressableScale
				className="flex-row items-center shrink-0"
				rippleColor="transparent"
				onPress={onPress}
			>
				<Text className={cn("text-sm", inflight ? "text-muted-foreground" : "text-foreground")}>@{name}</Text>
			</PressableScale>
		)
	},
	{
		propsAreEqual(prevProps, nextProps) {
			return (
				prevProps.name === nextProps.name &&
				isEqual(prevProps.participant, nextProps.participant) &&
				prevProps.inflight === nextProps.inflight
			)
		}
	}
)

export const CodeBlock = memo(({ match, fromSelf }: { match: string; fromSelf: boolean }) => {
	const code = useMemo(() => {
		let code = match.split("```").join("").trim()

		while (code.startsWith("\n")) {
			code = code.slice(1, code.length)
		}

		while (code.endsWith("\n")) {
			code = code.slice(0, code.length - 1)
		}

		return code
	}, [match])

	return (
		<View className={cn("flex-1 rounded-lg basis-full p-2 shrink-0", fromSelf ? "bg-blue-400" : "bg-background-tertiary")}>
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
})

export const Link = memo(({ match, fromSelf, inflight }: { match: string; fromSelf: boolean; inflight?: boolean }) => {
	const [chatTrustedDomains, setChatTrustedDomains] = useSecureStore<string[]>("chatTrustedDomains", [])

	const parsedDomain = useMemo(() => {
		try {
			const url = new URL(match)

			return url.hostname
		} catch {
			return null
		}
	}, [match])

	const onPress = useCallback(async () => {
		if (!parsedDomain) {
			return
		}

		const canOpenResult = await run(async () => {
			return await Linking.canOpenURL(match)
		})

		if (!canOpenResult.success) {
			console.error(canOpenResult.error)
			alerts.error(canOpenResult.error)

			return
		}

		if (!canOpenResult.data) {
			alerts.error("tbd_cannot_open_link")

			return
		}

		let trusted = chatTrustedDomains.includes(parsedDomain)

		if (!trusted) {
			const promptResponse = await run(async () => {
				return await prompts.alert({
					title: "tbd_open_external_link",
					message: "tbd_open_external_link_message",
					cancelText: "tbd_cancel",
					okText: "tbd_open_trust"
				})
			})

			if (!promptResponse.success) {
				console.error(promptResponse.error)
				alerts.error(promptResponse.error)

				return
			}

			if (promptResponse.data.cancelled) {
				return
			}

			setChatTrustedDomains(prev => [...prev, parsedDomain])

			trusted = true
		}

		const openResult = await run(async () => {
			return await Linking.openURL(match)
		})

		if (!openResult.success) {
			console.error(openResult.error)
			alerts.error(openResult.error)

			return
		}
	}, [match, parsedDomain, chatTrustedDomains, setChatTrustedDomains])

	if (!parsedDomain) {
		return match
	}

	return (
		<PressableScale
			className="flex-row items-center shrink-0"
			rippleColor="transparent"
			onPress={onPress}
		>
			<Text className={cn("underline", inflight ? "text-muted-foreground" : fromSelf ? "text-foreground" : "text-blue-500")}>
				{match}
			</Text>
		</PressableScale>
	)
})

export const Regexed = memo(
	({ chat, message, fromSelf }: { chat: Chat; message: ChatMessageWithInflightId; fromSelf: boolean }) => {
		const isInflight = useChatsStore(
			useShallow(state => state.inflightMessages[chat.uuid]?.messages.some(m => m.inflightId === message.inflightId))
		)

		const replaced = useMemo(() => {
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
							return <Mention name="tbd_everyone" />
						}

						if (!email.includes("@")) {
							return <Mention name="tbd_unknown" />
						}

						const foundParticipant = chat.participants.find(p => p.email === email)

						if (!foundParticipant) {
							return <Mention name="tbd_unknown" />
						}

						return (
							<Mention
								name={contactDisplayName(foundParticipant)}
								participant={foundParticipant}
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

					if (match.startsWith("https://") || match.startsWith("http://")) {
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
							/>
						)
					}

					return match
				},
				input: message.inner.message
			}) as (string | React.ReactElement)[]

			return regexed
		}, [message.inner.message, chat.participants, fromSelf, isInflight])

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
	},
	{
		propsAreEqual(prevProps, nextProps) {
			return (
				isEqual(prevProps.chat.participants, nextProps.chat.participants) &&
				prevProps.chat.uuid === nextProps.chat.uuid &&
				prevProps.message.inner.message === nextProps.message.inner.message &&
				prevProps.message.inflightId === nextProps.message.inflightId &&
				prevProps.fromSelf === nextProps.fromSelf
			)
		}
	}
)

export default Regexed
