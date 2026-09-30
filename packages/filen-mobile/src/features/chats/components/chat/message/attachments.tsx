import { type Chat as TChat } from "@/types"
import View from "@/components/ui/view"
import { extractLinks } from "@/lib/linkParser"
import { type ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"
import { useShallow } from "zustand/shallow"
import Regexed from "@/features/chats/components/chat/message/regexed"
import useChatMessageLinksQuery from "@/features/chats/queries/useChatMessageLinks.query"
import { useMappingHelper, useRecyclingState } from "@shopify/flash-list"
import useHttpStore from "@/stores/useHttp.store"
import VideoAttachment from "@/features/chats/components/chat/message/videoAttachment"
import ImageAttachment from "@/features/chats/components/chat/message/imageAttachment"
import InternalAttachment from "@/features/chats/components/chat/message/internalAttachment"
import { resolveLinkMedia, type SuccessfulLink } from "@/features/chats/utils"
import { type AnyFile } from "@filen/sdk-rs"

// A plain function rather than a component so each attachment costs no extra fiber.
function renderLinkMedia({
	link,
	fromSelf,
	maxWidth,
	getFileUrl,
	onLoadFailed
}: {
	link: SuccessfulLink
	fromSelf: boolean
	maxWidth: number
	getFileUrl: ((file: AnyFile) => string) | null
	onLoadFailed?: () => void
}) {
	const media = resolveLinkMedia(link, getFileUrl)

	switch (media.type) {
		case "image": {
			return (
				<ImageAttachment
					url={media.url}
					name={media.name}
					maxWidth={maxWidth}
					onLoadFailed={onLoadFailed}
					linked={media.linked ?? undefined}
				/>
			)
		}

		case "video": {
			return (
				<VideoAttachment
					url={media.url}
					name={media.name}
					maxWidth={maxWidth}
					linked={media.linked ?? undefined}
					fromSelf={fromSelf}
				/>
			)
		}

		case "internal": {
			return (
				<InternalAttachment
					data={media.linked}
					maxWidth={maxWidth}
					fromSelf={fromSelf}
				/>
			)
		}

		default: {
			return null
		}
	}
}

export const Attachments = ({
	chat,
	message,
	fromSelf,
	single,
	maxWidth
}: {
	chat: TChat
	message: ChatMessageWithInflightId
	fromSelf: boolean
	single: boolean
	maxWidth: number
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

	// Read the DATA, not the last fetch's verdict (#103).
	if (!chatMessageLinksQuery.data || chatMessageLinksQuery.data.length === 0) {
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
		const media =
			link && link.success && !singleAttachmentLoadFailed
				? renderLinkMedia({
						link,
						fromSelf,
						maxWidth,
						getFileUrl: getHttpProviderFileUrl,
						onLoadFailed: () => setSingleAttachmentLoadFailed(true)
					})
				: null

		return (
			media ?? (
				<Regexed
					chat={chat}
					message={message}
					fromSelf={fromSelf}
				/>
			)
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

				return (
					<View
						key={mappingHelper.getMappingKey(linkKey, index)}
						className="bg-transparent basis-full"
					>
						{link.success
							? renderLinkMedia({
									link,
									fromSelf,
									maxWidth,
									getFileUrl: getHttpProviderFileUrl
								})
							: null}
					</View>
				)
			})}
		</View>
	)
}

export default Attachments
