import Text from "@/components/ui/text"
import { Platform } from "react-native"
import { useLocalSearchParams, Redirect, router } from "expo-router"
import { unpack } from "@/lib/msgpack"
import { Buffer } from "react-native-quick-crypto"
import type { DriveItem } from "@/types"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import Header from "@/components/ui/header"
import { Fragment, memo } from "react"
import { useResolveClassNames } from "uniwind"
import { run, formatBytes } from "@filen/utils"
import { useStringifiedClient } from "@/lib/auth"
import useDriveItemVersionsQuery from "@/queries/useDriveItemVersions.query"
import VirtualList from "@/components/ui/virtualList"
import { simpleDate } from "@/lib/time"
import drive from "@/lib/drive"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import Ionicons from "@expo/vector-icons/Ionicons"
import type { FileVersion } from "@filen/sdk-rs"
import Menu from "@/components/ui/menu"
import { PressableScale } from "@/components/ui/pressables"

const Version = memo(({ version, item }: { version: FileVersion; item: DriveItem }) => {
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<View className="flex-row items-center px-4 bg-transparent">
			<View className="flex-row items-center gap-4 py-2 bg-transparent border-b border-border">
				<View className="flex-col bg-transparent flex-1 gap-0.5">
					<Text
						className="text-foreground"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{simpleDate(Number(version.timestamp))}
					</Text>
					<Text
						className="text-muted-foreground text-xs"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{version.uuid === item.data.uuid ? "tbd_current • " : ""}
						{formatBytes(Number(version.size))}
					</Text>
				</View>
				{version.uuid !== item.data.uuid && (
					<View className="flex-row items-center gap-4 bg-transparent">
						<Menu
							type="dropdown"
							buttons={[
								{
									id: "restore",
									title: "tbd_restore",
									onPress: async () => {
										const promptResponse = await run(async () => {
											return await prompts.alert({
												title: "tbd_restore_version",
												message: "tbd_restore_version_confirmation",
												cancelText: "tbd_cancel",
												okText: "tbd_restore",
												destructive: true
											})
										})

										if (!promptResponse.success) {
											console.error(promptResponse.error)
											alerts.error(promptResponse.error)

											return
										}

										if (promptResponse.data.cancelled) {
											return
										}

										const result = await runWithLoading(async () => {
											await drive.restoreFileVersion({
												item,
												version
											})
										})

										if (!result.success) {
											console.error(result.error)
											alerts.error(result.error)

											return
										}
									}
								},
								{
									id: "delete",
									title: "tbd_delete",
									destructive: true,
									onPress: async () => {
										const promptResponse = await run(async () => {
											return await prompts.alert({
												title: "tbd_delete_version",
												message: "tbd_delete_version_confirmation",
												cancelText: "tbd_cancel",
												okText: "tbd_delete",
												destructive: true
											})
										})

										if (!promptResponse.success) {
											console.error(promptResponse.error)
											alerts.error(promptResponse.error)

											return
										}

										if (promptResponse.data.cancelled) {
											return
										}

										const result = await runWithLoading(async () => {
											await drive.deleteVersion({
												item,
												version
											})
										})

										if (!result.success) {
											console.error(result.error)
											alerts.error(result.error)

											return
										}
									}
								}
							]}
						>
							<CrossGlassContainerView>
								<PressableScale className="size-9 items-center justify-center">
									<Ionicons
										name="ellipsis-horizontal"
										size={20}
										color={textForeground.color}
									/>
								</PressableScale>
							</CrossGlassContainerView>
						</Menu>
					</View>
				)}
			</View>
		</View>
	)
})

const FileVersions = memo(() => {
	const { itemPackedBase64 } = useLocalSearchParams<{
		itemPackedBase64?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const stringifiedClient = useStringifiedClient()

	const item = (() => {
		if (!itemPackedBase64) {
			return null
		}

		try {
			return unpack(Buffer.from(itemPackedBase64, "base64")) as DriveItem
		} catch {
			return null
		}
	})()

	const driveItemVersionsQuery = useDriveItemVersionsQuery(
		{
			uuid: item?.data.uuid ?? ""
		},
		{
			enabled: !!item && item.type === "file"
		}
	)

	const versions = driveItemVersionsQuery.data ?? []
	const versionsWithoutCurrent = item ? versions.filter(version => version.uuid !== item.data.uuid) : versions

	if (!item || item.type !== "file") {
		return (
			<Redirect
				href={{
					pathname: "/tabs/drive/[uuid]",
					params: {
						uuid: stringifiedClient?.rootUuid ?? "root"
					}
				}}
			/>
		)
	}

	return (
		<Fragment>
			<Header
				title="tbd_file_versions"
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
				rightItems={
					versionsWithoutCurrent.length > 0
						? [
								{
									type: "button",
									icon: {
										name: "trash-bin-outline",
										color: textForeground.color,
										size: 20
									},
									props: {
										onPress: async () => {
											const promptResponse = await run(async () => {
												return await prompts.alert({
													title: "tbd_delete__all_cversion",
													message: "tbd_delete_version_c_all_confirmation",
													cancelText: "tbd_cancel",
													okText: "tbd_delete_all_c",
													destructive: true
												})
											})

											if (!promptResponse.success) {
												console.error(promptResponse.error)
												alerts.error(promptResponse.error)

												return
											}

											if (promptResponse.data.cancelled) {
												return
											}

											const result = await runWithLoading(async () => {
												await Promise.all(
													versionsWithoutCurrent.map(version => {
														return drive.deleteVersion({
															item,
															version
														})
													})
												)
											})

											if (!result.success) {
												console.error(result.error)
												alerts.error(result.error)

												return
											}
										}
									}
								}
							]
						: undefined
				}
			/>
			<VirtualList
				data={versions}
				loading={driveItemVersionsQuery.status !== "success"}
				renderItem={({ item: version }) => {
					return (
						<Version
							version={version}
							item={item}
						/>
					)
				}}
				keyExtractor={version => version.uuid}
			/>
		</Fragment>
	)
})

export default FileVersions
