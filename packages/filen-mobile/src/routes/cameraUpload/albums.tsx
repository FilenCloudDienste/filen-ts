import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/routes/tabs/more"
import { useCameraUpload, DEFAULT_CONFIG } from "@/lib/cameraUpload"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment, memo, useEffect } from "react"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform, ActivityIndicator, AppState } from "react-native"
import { useSimpleQuery } from "@/hooks/useSimpleQuery"
import * as MediaLibraryLegacy from "expo-media-library"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Text from "@/components/ui/text"

const Albums = memo(() => {
	const { config, setConfig } = useCameraUpload()
	const insets = useSafeAreaInsets()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const textForeground = useResolveClassNames("text-foreground")

	const albumsQuery = useSimpleQuery(async () => {
		const permissions = await MediaLibraryLegacy.getPermissionsAsync()

		if (!permissions.granted) {
			if (!permissions.canAskAgain) {
				return []
			}

			const requestResult = await MediaLibraryLegacy.requestPermissionsAsync()

			if (!requestResult.granted) {
				return []
			}
		}

		const albums = await MediaLibraryLegacy.getAlbumsAsync({
			includeSmartAlbums: true
		})

		return albums
	})

	useEffect(() => {
		const subscription = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "active" || nextAppState === "background") {
				albumsQuery.refetch()
			}
		})

		return () => {
			subscription.remove()
		}
	}, [albumsQuery])

	return (
		<Fragment>
			<Header
				title="tbd_albums"
				transparent={Platform.OS === "ios"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.color as string | undefined
				})}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				{albumsQuery.status === "loading" ? (
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
							buttons={albumsQuery.data.map(album => {
								return {
									title: album.title,
									badge: album.assetCount.toString(),
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
				) : (
					<View className="flex-1 items-center justify-center px-4 bg-transparent gap-2">
						<Ionicons
							name="albums-outline"
							size={64}
							color={textMutedForeground.color}
						/>
						<Text>tbd_no_albums</Text>
					</View>
				)}
			</SafeAreaView>
		</Fragment>
	)
})

export default Albums
