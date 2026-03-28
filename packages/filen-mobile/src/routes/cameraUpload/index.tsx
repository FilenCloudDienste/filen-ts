import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/routes/tabs/more"
import { useCameraUpload, DEFAULT_CONFIG } from "@/lib/cameraUpload"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment, memo, useEffect } from "react"
import { router } from "expo-router"
import { selectDriveItems } from "@/routes/driveSelect/[uuid]"
import alerts from "@/lib/alerts"
import { run } from "@filen/utils"
import cache from "@/lib/cache"
import { AnyNormalDir_Tags } from "@filen/sdk-rs"
import { unwrapDirMeta } from "@/lib/utils"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform, ActivityIndicator, AppState } from "react-native"
import { useSimpleQuery } from "@/hooks/useSimpleQuery"
import * as MediaLibraryLegacy from "expo-media-library"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Text from "@/components/ui/text"

const CameraUpload = memo(() => {
	const { config, setConfig } = useCameraUpload()
	const textGreen500 = useResolveClassNames("text-green-500")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()

	const permissionsQuery = useSimpleQuery(async () => {
		const permissions = await MediaLibraryLegacy.getPermissionsAsync()

		if (!permissions.granted) {
			if (!permissions.canAskAgain) {
				return false
			}

			const requestResult = await MediaLibraryLegacy.requestPermissionsAsync()

			if (!requestResult.granted) {
				return false
			}
		}

		return true
	})

	useEffect(() => {
		const subscription = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "active" || nextAppState === "background") {
				permissionsQuery.refetch()
			}
		})

		return () => {
			subscription.remove()
		}
	}, [permissionsQuery])

	return (
		<Fragment>
			<Header
				title="tbd_camera_upload"
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
				{permissionsQuery.status === "loading" ? (
					<View className="flex-1 bg-transparent items-center justify-center">
						<ActivityIndicator
							size="large"
							color={textForeground.color as string}
						/>
					</View>
				) : permissionsQuery.data ? (
					<GestureHandlerScrollView
						className="bg-transparent flex-1"
						contentInsetAdjustmentBehavior="automatic"
						contentContainerClassName="px-4 gap-4"
						showsHorizontalScrollIndicator={false}
						contentContainerStyle={{
							paddingBottom: insets.bottom
						}}
					>
						<Group
							className="bg-background-tertiary"
							buttons={[
								{
									icon: "time-outline",
									title: "tbd_enabled",
									rightItem: {
										type: "switch",
										value: config.enabled,
										onValueChange: () => {
											setConfig(prev => {
												prev = {
													...DEFAULT_CONFIG,
													...prev
												}

												return {
													...prev,
													enabled: !prev.enabled
												}
											})
										}
									}
								}
							]}
						/>
						{config.enabled && (
							<Fragment>
								<Group
									className="bg-background-tertiary"
									buttons={[
										{
											icon: "time-outline",
											title: "tbd_albums",
											subTitle: "tbd_albums_description",
											onPress: () => {
												router.push("/cameraUpload/albums")
											},
											rightItem: {
												type: "text",
												value: config.albumIds.length.toString()
											}
										},
										{
											icon: "time-outline",
											title: "tbd_cloud_directory",
											subTitle: config.remoteDir
												? (unwrapDirMeta(config.remoteDir).meta?.name ?? "tbd_cloud_directory_description")
												: "tbd_cloud_directory_description",
											rightItem: {
												type: "badge",
												value: (
													<Ionicons
														name={
															config.remoteDir && unwrapDirMeta(config.remoteDir).meta ? "checkmark" : "close"
														}
														size={15}
														color="white"
													/>
												),
												color:
													config.remoteDir && unwrapDirMeta(config.remoteDir).meta
														? (textGreen500.color as string | undefined)
														: undefined
											},
											onPress: async () => {
												const result = await run(async () => {
													return await selectDriveItems({
														type: "single",
														files: false,
														directories: true,
														items: []
													})
												})

												if (!result.success) {
													console.error(result.error)
													alerts.error(result.error)

													return
												}

												if (result.data.cancelled) {
													return
												}

												const selectedItem = result.data.selectedItems[0]

												if (!selectedItem || selectedItem.type !== "directory") {
													return
												}

												const fromCache = cache.directoryUuidToAnyNormalDir.get(selectedItem.data.uuid)

												if (!fromCache || fromCache.tag !== AnyNormalDir_Tags.Dir) {
													return
												}

												setConfig(prev => {
													prev = {
														...DEFAULT_CONFIG,
														...prev
													}

													return {
														...prev,
														remoteDir: fromCache.inner[0]
													}
												})
											}
										}
									]}
								/>
								<Group
									className="bg-background-tertiary"
									buttons={[
										{
											icon: "time-outline",
											title: "tbd_videos",
											subTitle: "tbd_videos_description",
											rightItem: {
												type: "switch",
												value: config.includeVideos,
												onValueChange: () => {
													setConfig(prev => {
														prev = {
															...DEFAULT_CONFIG,
															...prev
														}

														return {
															...prev,
															includeVideos: !prev.includeVideos
														}
													})
												}
											}
										},
										{
											icon: "time-outline",
											title: "tbd_cellular",
											subTitle: "tbd_cellular_description",
											rightItem: {
												type: "switch",
												value: config.cellular,
												onValueChange: () => {
													setConfig(prev => {
														prev = {
															...DEFAULT_CONFIG,
															...prev
														}

														return {
															...prev,
															cellular: !prev.cellular
														}
													})
												}
											}
										},
										{
											icon: "time-outline",
											title: "tbd_background",
											subTitle: "tbd_background_description",
											rightItem: {
												type: "switch",
												value: config.background,
												onValueChange: () => {
													setConfig(prev => {
														prev = {
															...DEFAULT_CONFIG,
															...prev
														}

														return {
															...prev,
															background: !prev.background
														}
													})
												}
											}
										},
										{
											icon: "time-outline",
											title: "tbd_low_battery",
											subTitle: "tbd_low_battery_description",
											rightItem: {
												type: "switch",
												value: config.lowBattery,
												onValueChange: () => {
													setConfig(prev => {
														prev = {
															...DEFAULT_CONFIG,
															...prev
														}

														return {
															...prev,
															lowBattery: !prev.lowBattery
														}
													})
												}
											}
										},
										{
											icon: "time-outline",
											title: "tbd_compress",
											subTitle: "tbd_compress_description",
											rightItem: {
												type: "switch",
												value: config.compress,
												onValueChange: () => {
													setConfig(prev => {
														prev = {
															...DEFAULT_CONFIG,
															...prev
														}

														return {
															...prev,
															compress: !prev.compress
														}
													})
												}
											}
										},
										{
											icon: "time-outline",
											title: "tbd_after_activation",
											subTitle: "tbd_after_activation_description",
											rightItem: {
												type: "switch",
												value: config.afterActivation,
												onValueChange: () => {
													setConfig(prev => {
														prev = {
															...DEFAULT_CONFIG,
															...prev
														}

														return {
															...prev,
															afterActivation: !prev.afterActivation
														}
													})
												}
											}
										}
									]}
								/>
							</Fragment>
						)}
					</GestureHandlerScrollView>
				) : (
					<View className="flex-1 items-center justify-center px-4 bg-transparent gap-2">
						<Ionicons
							name="lock-closed-outline"
							size={64}
							color={textMutedForeground.color}
						/>
						<Text>tbd_no_permissions</Text>
					</View>
				)}
			</SafeAreaView>
		</Fragment>
	)
})

export default CameraUpload
