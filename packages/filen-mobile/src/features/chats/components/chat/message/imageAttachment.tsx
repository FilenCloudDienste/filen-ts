import { cn } from "@filen/utils"
import { useRecyclingState } from "@shopify/flash-list"
import Image from "@/components/ui/image"
import cache from "@/lib/cache"
import { PressableScale } from "@/components/ui/pressables"
import { type InternalLinkData, openAttachmentPreview } from "@/features/chats/utils"

export const ImageAttachment = ({
	url,
	name,
	layout,
	onLoadFailed,
	linked
}: {
	url: string
	name: string
	layout: {
		width: number
		height: number
	}
	onLoadFailed?: () => void
	linked?: InternalLinkData
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
				openAttachmentPreview({
					linked,
					url,
					name
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

export default ImageAttachment
