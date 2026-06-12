import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Group, type Button } from "@/components/ui/settingsGroup"
import cameraUpload, { useCameraUploadConfig, DEFAULT_CONFIG, type Config } from "@/features/cameraUpload/cameraUpload"
import { applyAfterActivationToggle, CAMERA_UPLOAD_REUPLOAD_DELETED_SECURE_STORE_KEY } from "@/features/cameraUpload/cameraUploadHelpers"
import { useSecureStore } from "@/lib/secureStore"
import View from "@/components/ui/view"
import { Fragment, useCallback } from "react"
import { router, useFocusEffect } from "expo-router"
import { selectDriveItems } from "@/features/drive/screens/driveSelect"
import alerts from "@/lib/alerts"
import { run } from "@filen/utils"
import cache from "@/lib/cache"
import { unwrapDirMeta } from "@/lib/sdkUnwrap"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform, ActivityIndicator } from "react-native"
import Text from "@/components/ui/text"
import useMediaPermissions from "@/hooks/useMediaPermissions"
import { AnyNormalDir_Tags } from "@filen/sdk-rs"
import useIsOnline from "@/hooks/useIsOnline"
import { useTranslation } from "react-i18next"

type BooleanConfigKey = {
	[K in keyof Config]: Config[K] extends boolean ? K : never
}[keyof Config]

const CameraUpload = () => {
	const { t } = useTranslation()
	const { config, setConfig } = useCameraUploadConfig()
	const [reuploadDeleted, setReuploadDeleted] = useSecureStore<boolean>(CAMERA_UPLOAD_REUPLOAD_DELETED_SECURE_STORE_KEY, false)
	const textGreen500 = useResolveClassNames("text-green-500")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const textForeground = useResolveClassNames("text-foreground")
	const isOnline = useIsOnline()

	// Camera upload syncs the photo library — it NEVER uses the camera. Scope the
	// permission check to the library so a user who grants full photo access but
	// denies the camera is not blocked here (and gets no spurious camera dialog).
	const mediaPermissions = useMediaPermissions({
		shouldRequest: true,
		library: "all",
		needCamera: false
	})

	const makeToggleButton = ({
		field,
		title,
		subTitle,
		icon
	}: {
		field: BooleanConfigKey
		title: string
		subTitle?: string
		icon: Button["icon"]
	}): Button => ({
		icon,
		title,
		subTitle,
		rightItem: {
			type: "switch",
			value: config[field],
			onValueChange: () => {
				setConfig(prev => {
					prev = {
						...DEFAULT_CONFIG,
						...prev
					}

					if (field === "afterActivation") {
						return applyAfterActivationToggle({
							config: prev,
							enabled: !prev.afterActivation,
							now: Date.now()
						})
					}

					return {
						...prev,
						[field]: !prev[field]
					}
				})
			}
		}
	})

	useFocusEffect(
		useCallback(() => {
			return () => {
				cameraUpload.sync().catch(console.error)
			}
		}, [])
	)

	return (
		<Fragment>
			<Header
				title={t("camera_upload")}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={Platform.select({
					ios: [
						{
							type: "button",
							icon: {
								name: "close",
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
					<SettingsScrollView>
						<Group
							className="bg-background-tertiary"
							buttons={[
								makeToggleButton({
									field: "enabled",
									title: t("enabled"),
									icon: "cloud-upload-outline"
								})
							]}
						/>
						{config.enabled && (
							<Fragment>
								<Group
									className="bg-background-tertiary"
									buttons={[
										{
											icon: "albums-outline",
											title: t("albums"),
											subTitle: t("albums_description"),
											onPress: () => {
												router.push("/cameraUpload/albums")
											},
											rightItem: {
												type: "text",
												value: config.albumIds.length.toString()
											}
										},
										{
											icon: "folder-open-outline",
											title: t("cloud_directory"),
											disabled: !isOnline,
											subTitle: config.remoteDir
												? config.remoteDir.tag === AnyNormalDir_Tags.Root
													? t("cloud_directory_root_description")
													: (unwrapDirMeta(config.remoteDir).meta?.name ?? t("cloud_directory_description"))
												: t("cloud_directory_description"),
											rightItem: {
												type: "badge",
												value: (
													<Ionicons
														name={config.remoteDir ? "checkmark" : "close"}
														size={15}
														color="white"
													/>
												),
												color: config.remoteDir ? (textGreen500.color as string | undefined) : undefined
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

												if (!selectedItem) {
													return
												}

												const remoteDir = (() => {
													if (selectedItem.type === "root") {
														return selectedItem.data
													}

													const fromCache = cache.directoryUuidToAnyNormalDir.get(selectedItem.data.data.uuid)

													if (!fromCache) {
														return null
													}

													return fromCache
												})()

												if (!remoteDir) {
													return
												}

												setConfig(prev => {
													prev = {
														...DEFAULT_CONFIG,
														...prev
													}

													return {
														...prev,
														remoteDir
													}
												})
											}
										}
									]}
								/>
								<Group
									className="bg-background-tertiary"
									buttons={[
										makeToggleButton({
											field: "includeVideos",
											title: t("videos"),
											subTitle: t("videos_description"),
											icon: "videocam-outline"
										}),
										makeToggleButton({
											field: "cellular",
											title: t("cellular"),
											subTitle: t("cellular_description"),
											icon: "cellular-outline"
										}),
										makeToggleButton({
											field: "background",
											title: t("background"),
											subTitle: t("background_description"),
											icon: "refresh-outline"
										}),
										makeToggleButton({
											field: "lowBattery",
											title: t("low_battery"),
											subTitle: t("low_battery_description"),
											icon: "battery-half-outline"
										}),
										makeToggleButton({
											field: "compress",
											title: t("compress"),
											subTitle: t("compress_description"),
											icon: "contract-outline"
										}),
										makeToggleButton({
											field: "afterActivation",
											title: t("after_activation"),
											subTitle: t("after_activation_description"),
											icon: "time-outline"
										}),
										{
											icon: "arrow-undo-outline",
											title: t("reupload_deleted"),
											subTitle: t("reupload_deleted_description"),
											rightItem: {
												type: "switch",
												value: reuploadDeleted,
												onValueChange: () => {
													setReuploadDeleted(prev => !prev)
												}
											}
										}
									]}
								/>
							</Fragment>
						)}
					</SettingsScrollView>
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

export default CameraUpload
