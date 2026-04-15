import Text from "@/components/ui/text"
import { Platform, ActivityIndicator } from "react-native"
import { useLocalSearchParams, router } from "expo-router"
import { deserialize } from "@/lib/serializer"
import Header, { type HeaderItem } from "@/components/ui/header"
import { Fragment, memo, useState } from "react"
import { useResolveClassNames } from "uniwind"
import type { DriveItem } from "@/types"
import DismissStack from "@/components/dismissStack"
import { View, GestureHandlerScrollView, CrossGlassContainerView } from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useDriveItemPublicLinkStatusQuery from "@/queries/useDriveItemPublicLinkStatus.query"
import Ionicons from "@expo/vector-icons/Ionicons"
import Button from "@/components/ui/button"
import drive from "@/lib/drive"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { Group } from "@/routes/tabs/more"
import { PressableOpacity } from "@/components/ui/pressables"
import { PasswordState_Tags, PasswordState, PublicLinkExpiration, DirColor } from "@filen/sdk-rs"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import * as Sharing from "expo-sharing"
import Menu from "@/components/ui/menu"
import { makeDriveItemPublicLink } from "@/lib/utils"
import Thumbnail from "@/components/drive/item/thumbnail"
import { DirectoryIcon } from "@/components/itemIcons"
import cache from "@/lib/cache"

function expirationToText(expiration: PublicLinkExpiration) {
	switch (expiration) {
		case PublicLinkExpiration.Never: {
			return "tbd_never"
		}

		case PublicLinkExpiration.OneHour: {
			return "tbd_one_hour"
		}

		case PublicLinkExpiration.SixHours: {
			return "tbd_six_hours"
		}

		case PublicLinkExpiration.OneDay: {
			return "tbd_one_day"
		}

		case PublicLinkExpiration.ThreeDays: {
			return "tbd_three_days"
		}

		case PublicLinkExpiration.OneWeek: {
			return "tbd_one_week"
		}

		case PublicLinkExpiration.TwoWeeks: {
			return "tbd_two_weeks"
		}

		case PublicLinkExpiration.ThirtyDays: {
			return "tbd_thirty_days"
		}

		default: {
			return "tbd_unknown"
		}
	}
}

const PublicLink = memo(() => {
	const { item: itemSerialized } = useLocalSearchParams<{
		item?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const insets = useSafeAreaInsets()
	const [edited, setEdited] = useState<{
		password?: PasswordState
		expiration?: PublicLinkExpiration
		downloadable?: boolean
	} | null>(null)

	const itemParsed = (() => {
		if (!itemSerialized) {
			return null
		}

		try {
			const item = deserialize(itemSerialized) as DriveItem

			if (cache.uuidToAnyDriveItem.has(item.data.uuid)) {
				return cache.uuidToAnyDriveItem.get(item.data.uuid) as DriveItem
			}

			return null
		} catch {
			return null
		}
	})()

	const publicLinkStatusQuery = useDriveItemPublicLinkStatusQuery(
		{
			uuid: itemParsed?.data.uuid ?? ""
		},
		{
			enabled: !!itemParsed
		}
	)

	if (!itemParsed || (itemParsed.type !== "file" && itemParsed.type !== "directory")) {
		return <DismissStack />
	}

	return (
		<Fragment>
			<Header
				title="tbd_public_link"
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
								name: "chevron-back-outline",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									if (router.canGoBack()) {
										router.back()
									}
								}
							}
						}
					] satisfies HeaderItem[],
					default: undefined
				})}
				rightItems={
					publicLinkStatusQuery.status === "success" && publicLinkStatusQuery.data !== null
						? edited
							? [
									{
										type: "button",
										icon: {
											name: "checkmark-outline",
											color: textForeground.color,
											size: 20
										},
										props: {
											onPress: async () => {
												const result = await runWithLoading(async () => {
													if (!publicLinkStatusQuery.data) {
														throw new Error("Public link status not found")
													}

													if (itemParsed.type !== publicLinkStatusQuery.data.type) {
														throw new Error("Mismatching item type and public link status type")
													}

													return await drive.updatePublicLink({
														item: itemParsed,
														link:
															publicLinkStatusQuery.data.type === "file"
																? {
																		type: "file" as const,
																		link: {
																			...publicLinkStatusQuery.data.status,
																			password:
																				edited.password ??
																				publicLinkStatusQuery.data.status.password,
																			downloadable:
																				edited.downloadable ??
																				publicLinkStatusQuery.data.status.downloadable,
																			expiration:
																				edited.expiration ??
																				publicLinkStatusQuery.data.status.expiration
																		}
																	}
																: {
																		type: "directory" as const,
																		link: {
																			...publicLinkStatusQuery.data.status,
																			password:
																				edited.password ??
																				publicLinkStatusQuery.data.status.password,
																			enableDownload:
																				edited.downloadable ??
																				publicLinkStatusQuery.data.status.enableDownload,
																			expiration:
																				edited.expiration ??
																				publicLinkStatusQuery.data.status.expiration
																		}
																	}
													})
												})

												if (!result.success) {
													console.error(result.error)
													alerts.error(result.error)

													return
												}

												setEdited(null)
											}
										}
									}
								]
							: [
									{
										type: "button",
										icon: {
											name: "share-social-outline",
											color: textForeground.color,
											size: 20
										},
										props: {
											onPress: async () => {
												const result = await run(async () => {
													if (!publicLinkStatusQuery.data) {
														throw new Error("Public link status not found")
													}

													const url = makeDriveItemPublicLink({
														item: itemParsed,
														linkUuid: publicLinkStatusQuery.data.status.linkUuid,
														linkKey:
															publicLinkStatusQuery.data.type === "directory"
																? publicLinkStatusQuery.data.status.linkKey
																: undefined
													})

													if (!url) {
														throw new Error("Failed to generate public link URL from parameters")
													}

													if (!(await Sharing.isAvailableAsync())) {
														throw new Error("Sharing is not available on this platform")
													}

													return await Sharing.shareAsync(url)
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
			{publicLinkStatusQuery.status === "success" ? (
				<Fragment>
					{publicLinkStatusQuery.data ? (
						<GestureHandlerScrollView
							className="bg-transparent"
							contentInsetAdjustmentBehavior="automatic"
							contentContainerClassName="px-4 pt-2 gap-4"
							contentContainerStyle={{
								paddingBottom: insets.bottom
							}}
							showsHorizontalScrollIndicator={false}
						>
							<View className="bg-transparent items-center justify-center flex-col py-10 px-4">
								{itemParsed.type === "directory" ? (
									<DirectoryIcon
										color={itemParsed.type === "directory" ? itemParsed.data.color : DirColor.Default.new()}
										width={128}
										height={128}
									/>
								) : (
									<Thumbnail
										item={itemParsed}
										size={{
											icon: 128,
											thumbnail: 128
										}}
										contentFit="cover"
										className="rounded-3xl"
									/>
								)}
								<Text
									className="text-lg font-bold mt-4"
									numberOfLines={1}
									ellipsizeMode="middle"
								>
									{itemParsed.data.decryptedMeta?.name ?? itemParsed.data.uuid}
								</Text>
								<Text className="text-muted-foreground">
									{itemParsed.type === "directory" ? "tbd_directory" : "tbd_file"}
								</Text>
							</View>
							<Group
								className="bg-background-tertiary"
								buttons={[
									{
										icon: "time-outline",
										title: "tbd_enabled",
										rightItem: {
											type: "switch",
											value: true,
											onValueChange: async () => {
												const result = await runWithLoading(async () => {
													return await drive.disablePublicLink({
														item: itemParsed
													})
												})

												if (!result.success) {
													console.error(result.error)
													alerts.error(result.error)

													return
												}

												setEdited(null)
											}
										}
									}
								]}
							/>
							<Group
								className="bg-background-tertiary"
								buttons={[
									{
										icon: "time-outline",
										title: "tbd_password",
										rightItem: {
											type: "custom",
											value: (
												<View className="flex-row items-center gap-4 bg-transparent">
													{(publicLinkStatusQuery.data.status.password.tag !== PasswordState_Tags.None ||
														(edited && edited.password && edited.password.tag !== PasswordState_Tags.None)) && (
														<Text className="text-muted-foreground text-sm">********</Text>
													)}
													<PressableOpacity
														onPress={async () => {
															const promptResult = await run(async () => {
																return await prompts.input({
																	title: "tbd_password",
																	message: "tbd_enter_password",
																	cancelText: "tbd_cancel",
																	okText: "tbd_save",
																	placeholder: "tbd_password",
																	inputType: "secure-text"
																})
															})

															if (!promptResult.success) {
																console.error(promptResult.error)
																alerts.error(promptResult.error)

																return
															}

															if (promptResult.data.cancelled || promptResult.data.type !== "string") {
																return
															}

															const newPassword = promptResult.data.value.trim()

															if (newPassword.length === 0) {
																return
															}

															setEdited(prev => ({
																...(prev ?? {}),
																password: PasswordState.Known.new(newPassword)
															}))
														}}
													>
														<Text className="text-blue-500 text-base">tbd_edit</Text>
													</PressableOpacity>
												</View>
											)
										}
									},
									{
										icon: "time-outline",
										title: "tbd_expiration",
										rightItem: {
											type: "custom",
											value: (
												<View className="flex-row items-center gap-4 bg-transparent">
													<Menu
														type="dropdown"
														buttons={[
															{
																title: "tbd_never",
																enum: PublicLinkExpiration.Never
															},
															{
																title: "tbd_one_hour",
																enum: PublicLinkExpiration.OneHour
															},
															{
																title: "tbd_six_hours",
																enum: PublicLinkExpiration.SixHours
															},
															{
																title: "tbd_one_day",
																enum: PublicLinkExpiration.OneDay
															},
															{
																title: "tbd_three_days",
																enum: PublicLinkExpiration.ThreeDays
															},
															{
																title: "tbd_one_week",
																enum: PublicLinkExpiration.OneWeek
															},
															{
																title: "tbd_two_weeks",
																enum: PublicLinkExpiration.TwoWeeks
															},
															{
																title: "tbd_thirty_days",
																enum: PublicLinkExpiration.ThirtyDays
															}
														].map(expiration => ({
															id: expiration.enum.toString(),
															title: expiration.title,
															checked:
																(edited && edited.expiration === expiration.enum) ||
																(publicLinkStatusQuery.data
																	? publicLinkStatusQuery.data.status.expiration === expiration.enum
																	: false),
															onPress: () => {
																setEdited(prev => ({
																	...(prev ?? {}),
																	expiration: expiration.enum
																}))
															}
														}))}
													>
														<CrossGlassContainerView className="min-h-9 p-2 px-3 items-center justify-center flex-row">
															<Text className="text-blue-500 text-base">
																{expirationToText(
																	edited && edited.expiration
																		? edited.expiration
																		: publicLinkStatusQuery.data.status.expiration
																)}
															</Text>
														</CrossGlassContainerView>
													</Menu>
												</View>
											)
										}
									},
									{
										icon: "time-outline",
										title: "tbd_downloadable",
										rightItem: {
											type: "switch",
											value:
												edited && typeof edited.downloadable === "boolean"
													? edited.downloadable
													: publicLinkStatusQuery.data.type === "file"
														? publicLinkStatusQuery.data.status.downloadable
														: publicLinkStatusQuery.data.status.enableDownload,
											onValueChange: async () => {
												setEdited(prev => ({
													...(prev ?? {}),
													downloadable:
														edited && typeof edited.downloadable === "boolean"
															? !edited.downloadable
															: publicLinkStatusQuery.data
																? publicLinkStatusQuery.data.type === "file"
																	? !publicLinkStatusQuery.data.status.downloadable
																	: !publicLinkStatusQuery.data.status.enableDownload
																: true
												}))
											}
										}
									}
								]}
							/>
						</GestureHandlerScrollView>
					) : (
						<View className="flex-1 items-center justify-center bg-transparent">
							<Ionicons
								name="link-outline"
								size={64}
								color={textMutedForeground.color}
							/>
							<Text className="mt-2">tbd_public_link_disabled</Text>
							<Text className="text-xs text-muted-foreground mt-0.5">tbd_public_link_description</Text>
							<View className="mt-4 bg-transparent">
								<Button
									onPress={async () => {
										const result = await runWithLoading(async () => {
											return await drive.enablePublicLink({
												item: itemParsed
											})
										})

										if (!result.success) {
											console.error(result.error)
											alerts.error(result.error)
										}
									}}
								>
									tbd_enable_public_link
								</Button>
							</View>
						</View>
					)}
				</Fragment>
			) : (
				<View className="flex-1 items-center justify-center bg-transparent">
					<ActivityIndicator
						color={textForeground.color}
						size="large"
					/>
				</View>
			)}
		</Fragment>
	)
})

export default PublicLink
