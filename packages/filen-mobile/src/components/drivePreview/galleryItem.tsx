import { memo, useMemo } from "@/lib/memo"
import { AnimatedView } from "@/components/ui/animated"
import { type DriveItemFileExtracted } from "@/types"
import { getPreviewType } from "@/lib/utils"
import useHttpStore from "@/stores/useHttp.store"
import { useWindowDimensions, ActivityIndicator } from "react-native"
import { type SharedValue, useAnimatedStyle } from "react-native-reanimated"
import { type ListRenderItemInfo } from "@shopify/flash-list"
import PreviewImage from "@/components/drivePreview/previewImage"
import PreviewVideo from "@/components/drivePreview/previewVideo"
import PreviewAudio from "@/components/drivePreview/previewAudio"
import PreviewText from "@/components/drivePreview/previewText"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { AnyFile } from "@filen/sdk-rs"
import PreviewPdf from "@/components/drivePreview/previewPdf"
import PreviewDocx from "@/components/drivePreview/previewDocx"
import View from "@/components/ui/view"

function getFileUrlForItem(item: DriveItemFileExtracted, getFileUrl: (file: AnyFile) => string): string | null {
	try {
		switch (item.type) {
			case "file": {
				return getFileUrl(new AnyFile.File(item.data))
			}

			case "sharedFile": {
				return getFileUrl(new AnyFile.Shared(item.data))
			}
		}
	} catch (e) {
		console.error(e)

		return null
	}
}

const GalleryItem = memo(
	({
		info,
		galleryZoomScale,
		dismissTranslateY,
		isDismissing,
		fadeRange,
		goBack,
		onZoomChange,
		onSingleTap
	}: {
		info: ListRenderItemInfo<DriveItemFileExtracted>
		galleryZoomScale: SharedValue<number>
		dismissTranslateY: SharedValue<number>
		isDismissing: SharedValue<number>
		fadeRange: number
		goBack: () => void
		onZoomChange?: (zoom: number) => void
		onSingleTap?: () => void
	}) => {
		const dimensions = useWindowDimensions()
		const getFileUrl = useHttpStore(useShallow(state => state.getFileUrl))
		const isActive = useDrivePreviewStore(useShallow(state => state.currentIndex === info.index))

		const previewType = useMemo(() => {
			return getPreviewType(info.item.data.decryptedMeta?.name ?? "")
		}, [info.item.data.decryptedMeta?.name])

		const fileUrl = useMemo(() => {
			if (!getFileUrl) {
				return null
			}

			return getFileUrlForItem(info.item, getFileUrl)
		}, [getFileUrl, info.item])

		const itemStyle = useMemo(
			() => ({
				width: dimensions.width,
				height: dimensions.height
			}),
			[dimensions.width, dimensions.height]
		)

		const dismissAnimatedStyle = useAnimatedStyle(() => {
			"worklet"

			if (!isActive && isDismissing.value !== 1) {
				return {}
			}

			const progress = Math.max(0, Math.min(1, Math.abs(dismissTranslateY.value) / fadeRange))

			return {
				transform: [
					{
						translateY: dismissTranslateY.value
					},
					{
						scale: 1 - progress * 0.15
					}
				]
			}
		})

		if (!fileUrl || !previewType || previewType === "unknown") {
			return (
				<AnimatedView
					className="bg-transparent"
					style={[itemStyle, dismissAnimatedStyle]}
				/>
			)
		}

		switch (previewType) {
			case "image": {
				return (
					<AnimatedView
						className="bg-transparent"
						style={[itemStyle, dismissAnimatedStyle]}
					>
						<PreviewImage
							fileUrl={fileUrl}
							zoomScale={galleryZoomScale}
							onPinchDismiss={goBack}
							onZoomChange={onZoomChange}
							onSingleTap={onSingleTap}
						/>
					</AnimatedView>
				)
			}

			case "pdf": {
				return (
					<AnimatedView
						className="bg-transparent"
						style={[itemStyle, dismissAnimatedStyle]}
					>
						{isActive ? (
							<PreviewPdf item={info.item} />
						) : (
							<View className="bg-transparent flex-1 items-center justify-center">
								<ActivityIndicator
									size="small"
									color="white"
								/>
							</View>
						)}
					</AnimatedView>
				)
			}

			case "docx": {
				return (
					<AnimatedView
						className="bg-transparent"
						style={[itemStyle, dismissAnimatedStyle]}
					>
						{isActive ? (
							<PreviewDocx item={info.item} />
						) : (
							<View className="bg-transparent flex-1 items-center justify-center">
								<ActivityIndicator
									size="small"
									color="white"
								/>
							</View>
						)}
					</AnimatedView>
				)
			}

			case "video": {
				return (
					<AnimatedView
						className="bg-transparent"
						style={[itemStyle, dismissAnimatedStyle]}
					>
						{isActive ? (
							<PreviewVideo fileUrl={fileUrl} />
						) : (
							<View className="bg-transparent flex-1 items-center justify-center">
								<ActivityIndicator
									size="small"
									color="white"
								/>
							</View>
						)}
					</AnimatedView>
				)
			}

			case "audio": {
				return (
					<AnimatedView
						className="bg-transparent"
						style={[itemStyle, dismissAnimatedStyle]}
					>
						{isActive ? (
							<PreviewAudio item={info.item} />
						) : (
							<View className="bg-transparent flex-1 items-center justify-center">
								<ActivityIndicator
									size="small"
									color="white"
								/>
							</View>
						)}
					</AnimatedView>
				)
			}

			case "text":
			case "code": {
				return (
					<AnimatedView
						className="bg-transparent"
						style={[itemStyle, dismissAnimatedStyle]}
					>
						{isActive ? (
							<PreviewText item={info.item} />
						) : (
							<View className="bg-transparent flex-1 items-center justify-center">
								<ActivityIndicator
									size="small"
									color="white"
								/>
							</View>
						)}
					</AnimatedView>
				)
			}

			default: {
				return (
					<AnimatedView
						className="bg-transparent"
						style={[itemStyle, dismissAnimatedStyle]}
					/>
				)
			}
		}
	}
)

export default GalleryItem
