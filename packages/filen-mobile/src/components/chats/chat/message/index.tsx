import { type Chat as TChat, AnyFile, DirColor, MaybeEncryptedUniffi_Tags, DirMeta_Tags } from "@filen/sdk-rs"
import View from "@/components/ui/view"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import Text from "@/components/ui/text"
import { cn, isTimestampSameMinute, formatBytes, run } from "@filen/utils"
import { useStringifiedClient } from "@/lib/auth"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn } from "react-native-reanimated"
import useChatsStore, { type ChatMessageWithInflightId } from "@/stores/useChats.store"
import { useShallow } from "zustand/shallow"
import { contactDisplayName, extractLinks, safeParseUrl } from "@/lib/utils"
import { Fragment, memo } from "react"
import { simpleDate } from "@/lib/time"
import Regexed from "@/components/chats/chat/message/regexed"
import Menu from "@/components/chats/chat/message/menu"
import useChatMessageLinksQuery, { type LinkResult } from "@/queries/useChatMessageLinks.query"
import { useMappingHelper, useRecyclingState } from "@shopify/flash-list"
import Image from "@/components/ui/image"
import useHttpStore from "@/stores/useHttp.store"
import cache from "@/lib/cache"
import Ionicons from "@expo/vector-icons/Ionicons"
import { FileIcon, DirectoryIcon } from "@/components/itemIcons"
import { useVideoPlayer, VideoView } from "expo-video"
import { PressableScale } from "@/components/ui/pressables"
import { router } from "expo-router"
import { serialize } from "@/lib/serializer"
import type { External } from "@/routes/drivePreview"
import alerts from "@/lib/alerts"
import drive from "@/lib/drive"

const Typing = memo(({ chat }: { chat: TChat }) => {
	const typing = useChatsStore(useShallow(state => state.typing[chat.uuid] ?? []))

	const users = typing
		.map(t => t.senderId)
		.map(senderId => chat.participants.find(p => p.userId === senderId))
		.filter(Boolean)
		.map(participant => contactDisplayName(participant!))

	if (users.length === 0) {
		return null
	}

	return (
		<AnimatedView
			entering={FadeIn.delay(100)}
			className="w-full h-auto pb-2 px-4 items-start"
		>
			<View className="p-3 rounded-3xl max-w-3/4 bg-background-secondary">
				<Text className="text-xs">{users.length > 1 ? `${users.join(", ")} tbd_typing...` : "..."}</Text>
			</View>
		</AnimatedView>
	)
})

const VideoAttachment = memo(
	({
		url,
		name,
		layout
	}: {
		url: string
		name: string
		layout: {
			width: number
			height: number
		}
	}) => {
		const player = useVideoPlayer(url, p => {
			p.loop = false
		})

		const maxWH = layout.width * 0.75 - 32 - 24

		const style = {
			width: maxWH,
			height: maxWH,
			borderRadius: 16
		}

		return (
			<PressableScale
				className="bg-background items-center justify-center rounded-2xl overflow-hidden flex-row"
				style={style}
				onPress={() => {
					router.push({
						pathname: "/drivePreview",
						params: {
							external: serialize({
								url,
								name
							} satisfies External)
						}
					})
				}}
			>
				<View className="absolute z-100 bg-transparent w-full h-full items-center justify-center">
					<Ionicons
						name="play-circle-outline"
						size={48}
						color="#ffffff"
					/>
				</View>
				<VideoView
					style={style}
					player={player}
					contentFit="cover"
					nativeControls={false}
					allowsPictureInPicture={false}
					focusable={false}
					fullscreenOptions={{
						enable: false
					}}
				/>
			</PressableScale>
		)
	}
)

const ImageAttachment = memo(
	({
		url,
		name,
		layout,
		onLoadFailed
	}: {
		url: string
		name: string
		layout: {
			width: number
			height: number
		}
		onLoadFailed?: () => void
	}) => {
		const [imageLayout, setImageLayout] = useRecyclingState<{
			width: number
			height: number
		} | null>(cache.chatAttachmentLayouts.get(url) ?? null, [url])

		const maxWH = layout.width * 0.75 - 32 - 24

		const style = {
			width: imageLayout ? Math.min(imageLayout.width, maxWH) : 1,
			height: imageLayout ? Math.min(imageLayout.height, Math.min(imageLayout.width, maxWH)) : 1
		}

		return (
			<PressableScale
				className="bg-transparent"
				style={style}
				onPress={() => {
					router.push({
						pathname: "/drivePreview",
						params: {
							external: serialize({
								url,
								name
							} satisfies External)
						}
					})
				}}
			>
				<Image
					onLoad={e => {
						const layout = {
							width: e.source.width,
							height: e.source.height
						}

						setImageLayout(layout)

						cache.chatAttachmentLayouts.set(url, layout)
					}}
					onError={onLoadFailed}
					className={cn("bg-transparent rounded-2xl", !imageLayout && "opacity-0")}
					style={style}
					source={{
						uri: url
					}}
					contentFit="cover"
					cachePolicy="disk"
				/>
			</PressableScale>
		)
	}
)

const InternalAttachment = memo(
	({
		data,
		layout
	}: {
		data: Extract<
			LinkResult,
			{
				type: "internal"
				success: true
			}
		>["data"]
		layout: {
			width: number
			height: number
		}
	}) => {
		const getHttpProviderFileUrl = useHttpStore(useShallow(state => state.getFileUrl))

		const maxWH = layout.width * 0.75 - 32 - 24

		return (
			<PressableScale
				className="bg-background items-center justify-center rounded-2xl overflow-hidden flex-row px-10 py-4 gap-4"
				style={{
					width: maxWH
				}}
				onPress={async () => {
					if (data.type === "directory") {
						const result = await run(async () => {
							return await drive.openLinkedDirectory({
								linkUuid: data.info.link.linkUuid,
								linkKey: data.info.link.linkKey,
								root: data.info.root
							})
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}

						return
					}

					const name = data.file.name.tag === MaybeEncryptedUniffi_Tags.Decrypted ? data.file.name.inner[0] : data.file.uuid

					if (data.previewType === "unknown") {
						const result = await run(async () => {
							return await drive.openLinkedFile({
								linkUuid: data.linkUuid,
								fileKey: data.fileKey
							})
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}

						return
					}

					if (!getHttpProviderFileUrl) {
						return
					}

					const url = getHttpProviderFileUrl(new AnyFile.Linked(data.file))

					router.push({
						pathname: "/drivePreview",
						params: {
							external: serialize({
								url,
								name
							} satisfies External)
						}
					})
				}}
			>
				{data.type === "directory" ? (
					<Fragment>
						<DirectoryIcon
							width={32}
							height={32}
							color={new DirColor.Default()}
						/>
						<View className="flex-col w-full h-auto bg-transparent">
							<Text
								numberOfLines={1}
								ellipsizeMode="middle"
							>
								{data.info.root.inner.meta.tag === DirMeta_Tags.Decoded
									? data.info.root.inner.meta.inner[0].name
									: data.info.root.inner.uuid}
							</Text>
							<Text className="text-xs text-muted-foreground">
								{simpleDate(
									Number(
										data.info.root.inner.meta.tag === DirMeta_Tags.Decoded && data.info.root.inner.meta.inner[0].created
											? data.info.root.inner.meta.inner[0].created
											: data.info.root.inner.timestamp
									)
								)}
							</Text>
						</View>
					</Fragment>
				) : (
					<Fragment>
						<FileIcon
							width={32}
							height={32}
							name={data.file.name.tag === MaybeEncryptedUniffi_Tags.Decrypted ? data.file.name.inner[0] : data.file.uuid}
						/>
						<View className="flex-col w-full h-auto bg-transparent">
							<Text
								numberOfLines={1}
								ellipsizeMode="middle"
							>
								{data.file.name.tag === MaybeEncryptedUniffi_Tags.Decrypted ? data.file.name.inner[0] : data.file.uuid}
							</Text>
							<Text className="text-xs text-muted-foreground">{formatBytes(Number(data.file.size))}</Text>
						</View>
					</Fragment>
				)}
			</PressableScale>
		)
	}
)

const Attachments = memo(
	({
		chat,
		message,
		fromSelf,
		single,
		layout
	}: {
		chat: TChat
		message: ChatMessageWithInflightId
		fromSelf: boolean
		single: boolean
		layout: {
			width: number
			height: number
		}
	}) => {
		const getHttpProviderFileUrl = useHttpStore(useShallow(state => state.getFileUrl))
		const mappingHelper = useMappingHelper()
		const [singleAttachmentLoadFailed, setSingleAttachmentLoadFailed] = useRecyclingState<boolean>(false, [message.inner.uuid])

		const links = extractLinks(message.inner.message ?? "")

		const chatMessageLinksQuery = useChatMessageLinksQuery(
			{
				links
			},
			{
				enabled: links.length > 0
			}
		)

		if (chatMessageLinksQuery.status !== "success" || chatMessageLinksQuery.data.length === 0) {
			if (single) {
				return (
					<Regexed
						chat={chat}
						message={message}
						fromSelf={fromSelf}
					/>
				)
			}

			return null
		}

		if (single) {
			const link = chatMessageLinksQuery.data[0]

			if (link && link.success && !singleAttachmentLoadFailed) {
				if (
					(link.type === "external" && link.data.previewType === "image") ||
					(link.type === "internal" && link.data.type === "file" && link.data.previewType === "image" && getHttpProviderFileUrl)
				) {
					const imageUrl =
						link.type === "external"
							? link.data.url
							: getHttpProviderFileUrl && link.data.type === "file"
								? getHttpProviderFileUrl(new AnyFile.Linked(link.data.file))
								: null

					const name =
						link.type === "external"
							? link.data.name
							: link.data.type === "file"
								? link.data.file.name.tag === MaybeEncryptedUniffi_Tags.Decrypted
									? link.data.file.name.inner[0]
									: link.data.file.uuid
								: null

					if (imageUrl && name) {
						return (
							<ImageAttachment
								url={imageUrl}
								name={name}
								layout={layout}
								onLoadFailed={() => setSingleAttachmentLoadFailed(true)}
							/>
						)
					}
				}

				if (
					(link.type === "external" && link.data.previewType === "video") ||
					(link.type === "internal" && link.data.type === "file" && link.data.previewType === "video" && getHttpProviderFileUrl)
				) {
					const videoUrl =
						link.type === "external"
							? link.data.url
							: getHttpProviderFileUrl && link.data.type === "file"
								? getHttpProviderFileUrl(new AnyFile.Linked(link.data.file))
								: null

					const name =
						link.type === "external"
							? link.data.name
							: link.data.type === "file"
								? link.data.file.name.tag === MaybeEncryptedUniffi_Tags.Decrypted
									? link.data.file.name.inner[0]
									: link.data.file.uuid
								: null

					if (videoUrl && name) {
						return (
							<VideoAttachment
								url={videoUrl}
								name={name}
								layout={layout}
							/>
						)
					}
				}

				if (link.type === "internal") {
					return (
						<InternalAttachment
							data={link.data}
							layout={layout}
						/>
					)
				}
			}

			return (
				<Regexed
					chat={chat}
					message={message}
					fromSelf={fromSelf}
				/>
			)
		}

		return (
			<View className="bg-transparent flex-col gap-4 mt-4">
				{chatMessageLinksQuery.data.map((link, index) => {
					const linkKey = link.success
						? link.type === "internal"
							? link.data.type === "file"
								? `link-internal-file-${link.data.file.uuid}`
								: `link-internal-directory-${link.data.info.link.linkUuid}`
							: `link-external-${link.data.url}`
						: `link-unsuccessful-${index}`

					if (link.success) {
						if (
							(link.type === "external" && link.data.previewType === "image") ||
							(link.type === "internal" &&
								link.data.type === "file" &&
								link.data.previewType === "image" &&
								getHttpProviderFileUrl)
						) {
							const imageUrl =
								link.type === "external"
									? link.data.url
									: getHttpProviderFileUrl && link.data.type === "file"
										? getHttpProviderFileUrl(new AnyFile.Linked(link.data.file))
										: null

							const name =
								link.type === "external"
									? link.data.name
									: link.data.type === "file"
										? link.data.file.name.tag === MaybeEncryptedUniffi_Tags.Decrypted
											? link.data.file.name.inner[0]
											: link.data.file.uuid
										: null

							if (imageUrl && name) {
								return (
									<View
										key={mappingHelper.getMappingKey(linkKey, index)}
										className="bg-transparent basis-full"
									>
										<ImageAttachment
											url={imageUrl}
											name={name}
											layout={layout}
										/>
									</View>
								)
							}
						}

						if (
							(link.type === "external" && link.data.previewType === "video") ||
							(link.type === "internal" &&
								link.data.type === "file" &&
								link.data.previewType === "video" &&
								getHttpProviderFileUrl)
						) {
							const videoUrl =
								link.type === "external"
									? link.data.url
									: getHttpProviderFileUrl && link.data.type === "file"
										? getHttpProviderFileUrl(new AnyFile.Linked(link.data.file))
										: null

							const name =
								link.type === "external"
									? link.data.name
									: link.data.type === "file"
										? link.data.file.name.tag === MaybeEncryptedUniffi_Tags.Decrypted
											? link.data.file.name.inner[0]
											: link.data.file.uuid
										: null

							if (videoUrl && name) {
								return (
									<View
										key={mappingHelper.getMappingKey(linkKey, index)}
										className="bg-transparent basis-full"
									>
										<VideoAttachment
											url={videoUrl}
											name={name}
											layout={layout}
										/>
									</View>
								)
							}
						}

						if (link.type === "internal") {
							return (
								<View
									key={mappingHelper.getMappingKey(linkKey, index)}
									className="bg-transparent basis-full"
								>
									<InternalAttachment
										data={link.data}
										layout={layout}
									/>
								</View>
							)
						}
					}

					return (
						<View
							className="bg-transparent basis-full"
							key={mappingHelper.getMappingKey(linkKey, index)}
						/>
					)
				})}
			</View>
		)
	}
)

const Message = memo(
	({
		chat,
		info,
		nextMessage,
		prevMessage,
		layout
	}: {
		chat: TChat
		info: ListRenderItemInfo<ChatMessageWithInflightId>
		nextMessage?: ChatMessageWithInflightId
		prevMessage?: ChatMessageWithInflightId
		layout: {
			width: number
			height: number
		}
	}) => {
		const stringifiedClient = useStringifiedClient()
		const isInflightError = useChatsStore(useShallow(state => state.inflightErrors[info.item.inflightId ?? ""]))

		const isMessageOnlyLink = (() => {
			if (!info.item.inner.message) {
				return false
			}

			const normalized = info.item.inner.message.trim().toLowerCase()
			const links = extractLinks(normalized).map(link => safeParseUrl(link.url))
			const link = links.length === 1 ? links[0] : null

			if (!link) {
				return false
			}

			return link.href.trim().toLowerCase() === normalized
		})()

		return (
			<View
				className={cn("w-full h-auto", info.item.inner.senderId === stringifiedClient?.userId ? "items-end" : "items-start")}
				style={{
					transform: [
						{
							scaleY: -1
						}
					]
				}}
			>
				{!isTimestampSameMinute(Number(prevMessage?.sentTimestamp ?? 0), Number(info.item.sentTimestamp)) && (
					<View className="w-full items-center justify-center py-2">
						<Text
							className="text-xs text-muted-foreground"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{simpleDate(Number(info.item.sentTimestamp))}
						</Text>
					</View>
				)}
				{chat.lastFocus &&
					info.item.sentTimestamp > chat.lastFocus &&
					info.item.inner.senderId !== stringifiedClient?.userId &&
					!(prevMessage && prevMessage.sentTimestamp > chat.lastFocus) && (
						<View className="flex-1 flex-row px-4 items-center pb-2">
							<View className="flex-row items-center justify-center bg-red-500 rounded-3xl p-1 px-2">
								<Text
									className="text-xs text-white"
									numberOfLines={1}
									ellipsizeMode="middle"
								>
									tbd_new
								</Text>
							</View>
							<View className="flex-1 bg-red-500 h-[0.5px]" />
						</View>
					)}
				{chat.participants.length > 2 && info.item.inner.senderId !== stringifiedClient?.userId && (
					<View className="max-w-3/4 flex-row items-center px-4 pb-1 pl-6">
						<Text className="text-xs text-muted-foreground">
							{contactDisplayName(chat.participants.find(p => p.userId === info.item.inner.senderId)!)}
						</Text>
					</View>
				)}
				<View className="h-auto max-w-3/4">
					<Menu
						chat={chat}
						info={info}
						className="w-full h-auto pb-2 px-4"
						isAnchoredToRight={info.item.inner.senderId !== stringifiedClient?.userId}
					>
						<View
							className={cn(
								"p-3 rounded-3xl w-auto h-auto flex-row shadow-sm",
								info.item.inner.senderId === stringifiedClient?.userId
									? cn(isInflightError ? "bg-red-500" : "bg-blue-500")
									: "bg-background-secondary"
							)}
						>
							{nextMessage?.inner.senderId !== info.item.inner.senderId && (
								<Fragment>
									{info.item.inner.senderId === stringifiedClient?.userId ? (
										<View className="absolute right-2 -bottom-1.75 overflow-hidden bg-transparent w-5 h-3.75">
											<View
												className={cn(
													isInflightError ? "bg-red-500" : "bg-blue-500",
													"absolute size-6.5 bottom-0 -right-3.25 rounded-[13px]"
												)}
											/>
										</View>
									) : (
										<View
											className="absolute left-2 -bottom-1.75 overflow-hidden bg-transparent w-5 h-3.75"
											style={{
												transform: [
													{
														scaleX: -1
													}
												]
											}}
										>
											<View className="bg-background-secondary absolute size-6.5 bottom-0 -right-3.25 rounded-[13px]" />
										</View>
									)}
								</Fragment>
							)}
							{isMessageOnlyLink ? (
								<Attachments
									chat={chat}
									message={info.item}
									fromSelf={info.item.inner.senderId === stringifiedClient?.userId}
									single={true}
									layout={layout}
								/>
							) : (
								<View className="flex-col bg-transparent w-auto h-auto">
									<View className="bg-transparent w-auto h-auto flex-row">
										<Regexed
											chat={chat}
											message={info.item}
											fromSelf={info.item.inner.senderId === stringifiedClient?.userId}
										/>
									</View>
									<Attachments
										chat={chat}
										message={info.item}
										fromSelf={info.item.inner.senderId === stringifiedClient?.userId}
										single={false}
										layout={layout}
									/>
								</View>
							)}
						</View>
					</Menu>
				</View>
				{!nextMessage && <Typing chat={chat} />}
			</View>
		)
	}
)

export default Message
