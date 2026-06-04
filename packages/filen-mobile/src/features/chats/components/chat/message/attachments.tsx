import { type Chat as TChat } from "@/types"
import View from "@/components/ui/view"
import { extractLinks } from "@/lib/utils"
import { type ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"
import { useShallow } from "zustand/shallow"
import Regexed from "@/features/chats/components/chat/message/regexed"
import useChatMessageLinksQuery from "@/features/chats/queries/useChatMessageLinks.query"
import { useMappingHelper, useRecyclingState } from "@shopify/flash-list"
import useHttpStore from "@/stores/useHttp.store"
import VideoAttachment from "@/features/chats/components/chat/message/videoAttachment"
import ImageAttachment from "@/features/chats/components/chat/message/imageAttachment"
import InternalAttachment from "@/features/chats/components/chat/message/internalAttachment"
import { resolveLinkMedia } from "@/features/chats/utils"

export const Attachments = ({
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

	const links = message.undecryptable ? [] : extractLinks(message.inner.message ?? "")

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
			const media = resolveLinkMedia(link, getHttpProviderFileUrl)

			if (media.type === "image" && media.url && media.name) {
				return (
					<ImageAttachment
						url={media.url}
						name={media.name}
						layout={layout}
						onLoadFailed={() => setSingleAttachmentLoadFailed(true)}
						linked={media.linked ?? undefined}
					/>
				)
			}

			if (media.type === "video" && media.url && media.name) {
				return (
					<VideoAttachment
						url={media.url}
						name={media.name}
						layout={layout}
						linked={media.linked ?? undefined}
						fromSelf={fromSelf}
					/>
				)
			}

			if (media.type === "internal" && media.linked) {
				return (
					<InternalAttachment
						data={media.linked}
						layout={layout}
						fromSelf={fromSelf}
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
					const media = resolveLinkMedia(link, getHttpProviderFileUrl)

					if (media.type === "image" && media.url && media.name) {
						return (
							<View
								key={mappingHelper.getMappingKey(linkKey, index)}
								className="bg-transparent basis-full"
							>
								<ImageAttachment
									url={media.url}
									name={media.name}
									layout={layout}
									linked={media.linked ?? undefined}
								/>
							</View>
						)
					}

					if (media.type === "video" && media.url && media.name) {
						return (
							<View
								key={mappingHelper.getMappingKey(linkKey, index)}
								className="bg-transparent basis-full"
							>
								<VideoAttachment
									url={media.url}
									name={media.name}
									layout={layout}
									linked={media.linked ?? undefined}
									fromSelf={fromSelf}
								/>
							</View>
						)
					}

					if (media.type === "internal" && media.linked) {
						return (
							<View
								key={mappingHelper.getMappingKey(linkKey, index)}
								className="bg-transparent basis-full"
							>
								<InternalAttachment
									data={media.linked}
									layout={layout}
									fromSelf={fromSelf}
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

export default Attachments
