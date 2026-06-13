import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import { useCameraUploadConfig, DEFAULT_CONFIG } from "@/features/cameraUpload/cameraUpload"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment, useEffect } from "react"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform, ActivityIndicator, AppState } from "react-native"
import { router } from "expo-router"
import useCameraUploadAlbumsQuery from "@/features/cameraUpload/queries/useCameraUploadAlbums.query"
import useCameraUploadAlbumLatestPhotoQuery from "@/features/cameraUpload/queries/useCameraUploadAlbumLatestPhoto.query"
import Image from "@/components/ui/image"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Text from "@/components/ui/text"
import useMediaPermissions from "@/hooks/useMediaPermissions"
import { useTranslation } from "react-i18next"
import ListEmpty from "@/components/ui/listEmpty"
import Button from "@/components/ui/button"

const ALBUM_PREVIEW_SIZE = {
	width: 34,
	height: 34
}

// Most-recent photo of the album as the row's leading preview. The fallback
// (no photos in the album / still resolving) is a blank recessed square —
// background-secondary, NOT tertiary, because the rows themselves sit on a
// background-tertiary card and would swallow it.
const AlbumPreview = ({ albumId }: { albumId: string }) => {
	const latestPhotoQuery = useCameraUploadAlbumLatestPhotoQuery({
		albumId
	})

	if (latestPhotoQuery.status === "success" && latestPhotoQuery.data) {
		return (
			<Image
				className="rounded-lg bg-background-secondary"
				source={{
					uri: latestPhotoQuery.data
				}}
				contentFit="cover"
				// Local photo-library URIs — a disk cache would just duplicate
				// what is already on disk; memory keeps scrolling smooth.
				cachePolicy="memory"
				recyclingKey={albumId}
				style={ALBUM_PREVIEW_SIZE}
			/>
		)
	}

	return (
		<View
			className="rounded-lg bg-background-secondary"
			style={ALBUM_PREVIEW_SIZE}
		/>
	)
}

const Albums = () => {
	const { t } = useTranslation()
	const { config, setConfig } = useCameraUploadConfig()
	const insets = useSafeAreaInsets()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const textForeground = useResolveClassNames("text-foreground")

	// The album picker only enumerates the photo library — it NEVER uses the
	// camera. Scope the permission check to the library so a user who grants full
	// photo access but denies the camera is not blocked here.
	const mediaPermissions = useMediaPermissions({
		shouldRequest: true,
		library: "all",
		needCamera: false
	})

	const albumsQuery = useCameraUploadAlbumsQuery()
	const { refetch } = albumsQuery

	useEffect(() => {
		const subscription = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "active") {
				refetch()
			}
		})

		return () => {
			subscription.remove()
		}
	}, [refetch])

	return (
		<Fragment>
			<Header
				title={t("albums")}
				shadowVisible={false}
				transparent={Platform.OS === "ios"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string | undefined
				})}
				leftItems={Platform.select({
					ios: [
						{
							type: "button",
							icon: {
								name: "chevron-back-outline",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									router.back()
								}
							}
						}
					],
					default: undefined
				})}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				{mediaPermissions.loading ? (
					<View className="flex-1 bg-transparent items-center justify-center">
						<ActivityIndicator
							size="large"
							color={textForeground.color as string}
						/>
					</View>
				) : mediaPermissions.granted ? (
					albumsQuery.status === "pending" ? (
						<View className="flex-1 bg-transparent items-center justify-center">
							<ActivityIndicator
								size="large"
								color={textForeground.color as string}
							/>
						</View>
					) : albumsQuery.status === "success" && albumsQuery.data.length > 0 ? (
						<GestureHandlerScrollView
							className="bg-transparent"
							contentInsetAdjustmentBehavior="automatic"
							contentContainerClassName="px-4 gap-4"
							contentContainerStyle={{
								paddingBottom: insets.bottom
							}}
							showsHorizontalScrollIndicator={false}
						>
							<Group
								className="bg-background-tertiary"
								buttons={albumsQuery.data
									.slice()
									.sort((a, b) => b.assetCount - a.assetCount)
									.map(album => {
										return {
											title: album.title,
											leading: <AlbumPreview albumId={album.id} />,
											badge: album.assetCount.toString(),
											badgeColor: bgBackgroundSecondary.backgroundColor as string | undefined,
											rightItem: {
												type: "switch",
												value: config.albumIds?.includes(album.id) ?? false,
												onValueChange: () => {
													setConfig(prev => {
														prev = {
															...DEFAULT_CONFIG,
															...prev
														}

														const albumIds = new Set(prev.albumIds ?? [])

														if (albumIds.has(album.id)) {
															albumIds.delete(album.id)
														} else {
															albumIds.add(album.id)
														}

														return {
															...prev,
															albumIds: Array.from(albumIds)
														}
													})
												}
											}
										}
									})}
							/>
						</GestureHandlerScrollView>
					) : albumsQuery.status === "error" ? (
						<ListEmpty
							icon="warning-outline"
							title={t("error_generic")}
							action={<Button onPress={() => refetch()}>{t("try_again")}</Button>}
						/>
					) : (
						<View className="flex-1 items-center justify-center px-4 bg-transparent gap-2">
							<Ionicons
								name="albums-outline"
								size={64}
								color={textMutedForeground.color}
							/>
							<Text>{t("no_albums")}</Text>
						</View>
					)
				) : (
					<View className="flex-1 items-center justify-center px-4 bg-transparent gap-2">
						<Ionicons
							name="lock-closed-outline"
							size={64}
							color={textMutedForeground.color}
						/>
						<Text>{t("no_permissions_enable_manually")}</Text>
					</View>
				)}
			</SafeAreaView>
		</Fragment>
	)
}

export default Albums
