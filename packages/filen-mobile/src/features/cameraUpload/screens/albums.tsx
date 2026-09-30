import { ScreenBody } from "@/components/ui/safeAreaView"
import { LoadingView } from "@/components/ui/loadingView"
import { Group } from "@/components/ui/settingsGroup"
import { useCameraUploadConfig } from "@/features/cameraUpload/cameraUpload"
import View from "@/components/ui/view"
import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import { Fragment } from "react"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform } from "react-native"
import { router } from "@/lib/router"
import useCameraUploadAlbumsQuery from "@/features/cameraUpload/queries/useCameraUploadAlbums.query"
import useCameraUploadAlbumLatestPhotoQuery from "@/features/cameraUpload/queries/useCameraUploadAlbumLatestPhoto.query"
import Image from "@/components/ui/image"
import useMediaPermissions from "@/hooks/useMediaPermissions"
import useOnAppForeground from "@/hooks/useOnAppForeground"
import { useTranslation } from "react-i18next"
import ListEmpty, { LoadErrorEmpty } from "@/components/ui/listEmpty"

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
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
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

	useOnAppForeground(refetch)

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
			<ScreenBody>
				{mediaPermissions.loading ? (
					<LoadingView />
				) : mediaPermissions.granted ? (
					albumsQuery.status === "pending" ? (
						<LoadingView />
					) : albumsQuery.status === "success" && albumsQuery.data.length > 0 ? (
						<SettingsScrollView>
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
												value: config.albumIds.includes(album.id),
												onValueChange: () => {
													setConfig(prev => {
														const albumIds = new Set(prev.albumIds)

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
						</SettingsScrollView>
					) : albumsQuery.status === "error" ? (
						<LoadErrorEmpty
							title={t("could_not_load_albums")}
							onRetry={() => refetch()}
						/>
					) : (
						<ListEmpty
							icon="albums-outline"
							title={t("no_albums")}
						/>
					)
				) : (
					<ListEmpty
						icon="lock-closed-outline"
						title={t("no_permissions_enable_manually")}
					/>
				)}
			</ScreenBody>
		</Fragment>
	)
}

export default Albums
