import Text from "@/components/ui/text"
import { Platform, ActivityIndicator } from "react-native"
import { useLocalSearchParams, router } from "expo-router"
import { deserialize } from "@/lib/serializer"
import Header, { type HeaderItem } from "@/components/ui/header"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Fragment, useState } from "react"
import { useTranslation } from "react-i18next"
import { type TFunction } from "i18next"
import { useResolveClassNames } from "uniwind"
import type { DriveItem } from "@/types"
import DismissStack from "@/components/dismissStack"
import { View, GestureHandlerScrollView, CrossGlassContainerView } from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useDriveItemPublicLinkStatusQuery from "@/features/drive/queries/useDriveItemPublicLinkStatus.query"
import Button from "@/components/ui/button"
import useIsOnline from "@/hooks/useIsOnline"
import drive from "@/features/drive/drive"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { Group } from "@/components/ui/settingsGroup"
import { PressableOpacity } from "@/components/ui/pressables"
import { PasswordState_Tags, PasswordState, PublicLinkExpiration, DirColor } from "@filen/sdk-rs"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import { shareUrl } from "@/lib/share"
import Menu from "@/components/ui/menu"
import { makeDriveItemPublicLink } from "@/lib/sdkUnwrap"
import Thumbnail from "@/features/drive/components/item/thumbnail"
import { DirectoryIcon } from "@/components/itemIcons"
import cache from "@/lib/cache"
import useAccountQuery from "@/queries/useAccount.query"
import { driveItemDisplayName } from "@/lib/decryption"
import CannotDecryptScreen from "@/components/cannotDecryptScreen"
import i18n from "@/lib/i18n"
import ListEmpty from "@/components/ui/listEmpty"
import { isExpirationChecked, isPublicLinkQueryError } from "@/features/publicLink/utils"
import logger from "@/lib/logger"

function expirationToText(expiration: PublicLinkExpiration, t: TFunction) {
	switch (expiration) {
		case PublicLinkExpiration.Never: {
			return t("never")
		}

		case PublicLinkExpiration.OneHour: {
			return t("one_hour")
		}

		case PublicLinkExpiration.SixHours: {
			return t("six_hours")
		}

		case PublicLinkExpiration.OneDay: {
			return t("one_day")
		}

		case PublicLinkExpiration.ThreeDays: {
			return t("three_days")
		}

		case PublicLinkExpiration.OneWeek: {
			return t("one_week")
		}

		case PublicLinkExpiration.TwoWeeks: {
			return t("two_weeks")
		}

		case PublicLinkExpiration.ThirtyDays: {
			return t("thirty_days")
		}

		default: {
			return t("unknown")
		}
	}
}

function PublicLink() {
	const { t } = useTranslation()
	const { item: itemSerialized } = useLocalSearchParams<{
		item?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const [edited, setEdited] = useState<{
		password?: PasswordState
		expiration?: PublicLinkExpiration
		downloadable?: boolean
	} | null>(null)
	const isOnline = useIsOnline()

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
		} catch (err) {
			logger.error("publicLink", "failed to deserialize item from route param", { error: String(err), itemSerialized: typeof itemSerialized === "string" ? itemSerialized.slice(0, 80) : null })

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

	const accountQuery = useAccountQuery()

	const userIsSubbed = accountQuery.status === "success" && accountQuery.data.subs.filter(sub => Number(sub.activated) === 1).length > 0

	if (!itemParsed || (itemParsed.type !== "file" && itemParsed.type !== "directory")) {
		return <DismissStack />
	}

	if (itemParsed.data.undecryptable) {
		return (
			<CannotDecryptScreen
				uuid={itemParsed.data.uuid}
				surface="publicLink"
			/>
		)
	}

	return (
		<Fragment>
			<Header
				title={t("public_link")}
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
					publicLinkStatusQuery.status === "success" && publicLinkStatusQuery.data !== null && userIsSubbed
						? edited && isOnline
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
														throw new Error(i18n.t("error_generic"))
													}

													if (itemParsed.type !== publicLinkStatusQuery.data.type) {
														throw new Error(i18n.t("error_generic"))
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
													logger.error("publicLink", "failed to update public link settings", { error: result.error instanceof Error ? result.error.message : String(result.error), uuid: itemParsed.data.uuid })
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
														throw new Error(i18n.t("error_generic"))
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
														throw new Error(i18n.t("public_link_generate_failed"))
													}

													return await shareUrl(url)
												})

												if (!result.success) {
													logger.error("publicLink", "failed to share public link url", { error: result.error instanceof Error ? result.error.message : String(result.error), uuid: itemParsed.data.uuid })
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
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				{publicLinkStatusQuery.status === "success" && accountQuery.status === "success" ? (
					<Fragment>
						{userIsSubbed ? (
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
												{driveItemDisplayName(itemParsed)}
											</Text>
											<Text className="text-muted-foreground">
												{itemParsed.type === "directory" ? t("directory") : t("file")}
											</Text>
										</View>
										<Group
											className="bg-background-tertiary"
											buttons={[
												{
													icon: "link-outline",
													title: t("enabled"),
													disabled: !isOnline,
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
																logger.error("publicLink", "failed to disable public link", { error: result.error instanceof Error ? result.error.message : String(result.error), uuid: itemParsed.data.uuid })
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
													icon: "lock-closed-outline",
													title: t("password"),
													rightItem: {
														type: "custom",
														value: (
															<View className="flex-row items-center gap-4 bg-transparent">
																{(publicLinkStatusQuery.data.status.password.tag !==
																	PasswordState_Tags.None ||
																	(edited &&
																		edited.password &&
																		edited.password.tag !== PasswordState_Tags.None)) && (
																	<Text className="text-muted-foreground text-sm">********</Text>
																)}
																<PressableOpacity
																	onPress={async () => {
																		const promptResult = await run(async () => {
																			return await prompts.input({
																				title: t("password"),
																				message: t("enter_the_password"),
																				cancelText: t("cancel"),
																				okText: t("save"),
																				placeholder: t("password"),
																				inputType: "secure-text"
																			})
																		})

																		if (!promptResult.success) {
																			logger.warn("publicLink", "password prompt failed", { error: promptResult.error instanceof Error ? promptResult.error.message : String(promptResult.error) })
																			alerts.error(promptResult.error)

																			return
																		}

																		if (
																			promptResult.data.cancelled ||
																			promptResult.data.type !== "string"
																		) {
																			return
																		}

																		const newPassword = promptResult.data.value

																		if (newPassword.length === 0) {
																			return
																		}

																		setEdited(prev => ({
																			...(prev ?? {}),
																			password: PasswordState.Known.new(newPassword)
																		}))
																	}}
																>
																	<Text className="text-blue-500 text-base">{t("edit")}</Text>
																</PressableOpacity>
															</View>
														)
													}
												},
												{
													icon: "calendar-outline",
													title: t("expiration"),
													rightItem: {
														type: "custom",
														value: (
															<View className="flex-row items-center gap-4 bg-transparent">
																<Menu
																	type="dropdown"
																	buttons={[
																		{
																			title: t("never"),
																			enum: PublicLinkExpiration.Never
																		},
																		{
																			title: t("one_hour"),
																			enum: PublicLinkExpiration.OneHour
																		},
																		{
																			title: t("six_hours"),
																			enum: PublicLinkExpiration.SixHours
																		},
																		{
																			title: t("one_day"),
																			enum: PublicLinkExpiration.OneDay
																		},
																		{
																			title: t("three_days"),
																			enum: PublicLinkExpiration.ThreeDays
																		},
																		{
																			title: t("one_week"),
																			enum: PublicLinkExpiration.OneWeek
																		},
																		{
																			title: t("two_weeks"),
																			enum: PublicLinkExpiration.TwoWeeks
																		},
																		{
																			title: t("thirty_days"),
																			enum: PublicLinkExpiration.ThirtyDays
																		}
																	].map(expiration => ({
																		id: expiration.enum.toString(),
																		title: expiration.title,
																		checked: isExpirationChecked({
																			candidate: expiration.enum,
																			editedExpiration: edited?.expiration,
																			serverExpiration: publicLinkStatusQuery.data?.status.expiration
																		}),
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
																					: publicLinkStatusQuery.data.status.expiration,
																				t
																			)}
																		</Text>
																	</CrossGlassContainerView>
																</Menu>
															</View>
														)
													}
												},
												{
													icon: "cloud-download-outline",
													title: t("downloadable"),
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
																	prev && typeof prev.downloadable === "boolean"
																		? !prev.downloadable
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
									<ListEmpty
										icon="link-outline"
										title={t("public_link_disabled")}
										description={t("public_link_description")}
										action={
											<Button
												disabled={!isOnline}
												onPress={async () => {
													if (!isOnline) {
														return
													}

													const result = await runWithLoading(async () => {
														return await drive.enablePublicLink({
															item: itemParsed
														})
													})

													if (!result.success) {
														logger.error("publicLink", "failed to enable public link", { error: result.error instanceof Error ? result.error.message : String(result.error), uuid: itemParsed.data.uuid })
														alerts.error(result.error)
													}
												}}
											>
												{t("enable_public_link")}
											</Button>
										}
									/>
								)}
							</Fragment>
						) : (
							<ListEmpty
								icon="link-outline"
								title={t("feature_requires_subscription")}
								description={t("feature_requires_subscription_public_links_description")}
							/>
						)}
					</Fragment>
				) : isPublicLinkQueryError(publicLinkStatusQuery.status, accountQuery.status) ? (
					<ListEmpty
						icon="warning-outline"
						title={t("could_not_load_link")}
						description={t("please_check_connection")}
						action={
							<Button
								onPress={() => {
									void publicLinkStatusQuery.refetch()
									void accountQuery.refetch()
								}}
							>
								{t("try_again")}
							</Button>
						}
					/>
				) : (
					<View className="flex-1 items-center justify-center bg-transparent">
						<ActivityIndicator
							color={textForeground.color}
							size="large"
						/>
					</View>
				)}
			</SafeAreaView>
		</Fragment>
	)
}

export default PublicLink
