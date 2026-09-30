import Text from "@/components/ui/text"
import { LoadingView } from "@/components/ui/loadingView"
import { useLocalSearchParams } from "expo-router"
import { goBackIfPossible } from "@/lib/router"
import { deserializeRouteParam } from "@/lib/serializer"
import SettingsHeader from "@/components/ui/settingsHeader"
import { ScreenBody } from "@/components/ui/safeAreaView"
import { Fragment, useState } from "react"
import { useTranslation } from "react-i18next"
import { type TFunction } from "i18next"
import { useResolveClassNames } from "uniwind"
import type { DriveItem } from "@/types"
import DismissStack from "@/components/dismissStack"
import { View, GestureHandlerScrollView, CrossGlassContainerView } from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useDriveItemPublicLinkStatusQuery, { publicLinkUrlFromStatus } from "@/features/drive/queries/useDriveItemPublicLinkStatus.query"
import Button from "@/components/ui/button"
import useIsOnline from "@/hooks/useIsOnline"
import drive from "@/features/drive/drive"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { Group } from "@/components/ui/settingsGroup"
import { PressableOpacity } from "@/components/ui/pressables"
import { PasswordState_Tags, PasswordState, PublicLinkExpiration } from "@filen/sdk-rs"
import { inputPrompt } from "@/lib/promptFlow"
import { run } from "@filen/shared"
import { shareUrl } from "@/lib/share"
import Menu from "@/components/ui/menu"
import Thumbnail from "@/features/drive/components/item/thumbnail"
import { DirectoryIcon } from "@/components/itemIcons"
import cache from "@/lib/cache"
import useAccountQuery from "@/queries/useAccount.query"
import { driveItemDisplayName } from "@/lib/decryption"
import CannotDecryptScreen from "@/components/cannotDecryptScreen"
import i18n from "@/lib/i18n"
import ListEmpty, { LoadErrorEmpty } from "@/components/ui/listEmpty"
import { recentHeldLinkStatus, isExpirationChecked, isPublicLinkQueryError, linkStatusForWrite } from "@/features/publicLink/utils"
import logger from "@/lib/logger"
import { type PublicLinkEdits } from "@/features/drive/drivePublicLink"

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
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const [edited, setEdited] = useState<PublicLinkEdits | null>(null)
	const isOnline = useIsOnline()

	const itemParam = deserializeRouteParam<DriveItem>(itemSerialized)
	// Prefer the cache copy (fresher — a rename that arrived over the socket lands there);
	// the deserialized param item is a valid fallback and must never be discarded.
	const itemParsed = itemParam ? (cache.uuidToAnyDriveItem.get(itemParam.data.uuid) ?? itemParam) : null

	const publicLinkStatusQuery = useDriveItemPublicLinkStatusQuery(
		{
			uuid: itemParsed?.data.uuid ?? "",
			item: itemParsed ?? undefined
		},
		{
			enabled: !!itemParsed
		}
	)

	const accountQuery = useAccountQuery()

	const userIsSubbed = accountQuery.status === "success" && accountQuery.data.subs.filter(sub => Number(sub.activated) === 1).length > 0

	// Only read inside the loaded-link branch, so the fallback is unreachable
	const serverDownloadable = publicLinkStatusQuery.data
		? publicLinkStatusQuery.data.type === "file"
			? publicLinkStatusQuery.data.status.downloadable
			: publicLinkStatusQuery.data.status.enableDownload
		: false

	if (!itemParsed || (itemParsed.type !== "file" && itemParsed.type !== "directory")) {
		return <DismissStack />
	}

	if (itemParsed.data.undecryptable) {
		return <CannotDecryptScreen uuid={itemParsed.data.uuid} />
	}

	return (
		<Fragment>
			<SettingsHeader
				title={t("public_link")}
				icon="close"
				onDismiss={goBackIfPossible}
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
													const status = await linkStatusForWrite(publicLinkStatusQuery)

													if (!status) {
														throw new Error(i18n.t("error_generic"))
													}

													if (itemParsed.type !== status.type) {
														throw new Error(i18n.t("error_generic"))
													}

													return await drive.updatePublicLink({
														item: itemParsed,
														held: status,
														edits: edited
													})
												})

												if (!result.success) {
													logger.error("publicLink", "failed to update public link settings", { error: result.error, uuid: itemParsed.data.uuid })
													alerts.error(result.error)

													return
												}

												setEdited(null)

												// Nothing was written; the screen now shows what the server has.
												if (result.data === "gone") {
													alerts.error(t("public_link_gone_elsewhere"))
												} else if (result.data === "replaced") {
													alerts.error(t("public_link_replaced_elsewhere"))
												}
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

													const url = publicLinkUrlFromStatus(itemParsed, publicLinkStatusQuery.data)

													if (!url) {
														throw new Error(i18n.t("public_link_generate_failed"))
													}

													return await shareUrl(url)
												})

												if (!result.success) {
													logger.error("publicLink", "failed to share public link url", { error: result.error, uuid: itemParsed.data.uuid })
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
			<ScreenBody>
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
													color={itemParsed.data.color}
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
													requiresOnline: true,
													rightItem: {
														type: "switch",
														value: true,
														onValueChange: async () => {
															const result = await runWithLoading(async () => {
																const held = recentHeldLinkStatus(publicLinkStatusQuery)

																return await drive.disablePublicLink({
																	item: itemParsed,
																	known: held.current ? (held.value ?? undefined) : undefined
																})
															})

															if (!result.success) {
																logger.error("publicLink", "failed to disable public link", { error: result.error, uuid: itemParsed.data.uuid })
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
																		const newPassword = await inputPrompt(
																			{
																				title: t("password"),
																				message: t("enter_the_password"),
																				cancelText: t("cancel"),
																				okText: t("save"),
																				placeholder: t("password"),
																				inputType: "secure-text"
																			},
																			{ tag: "publicLink", message: "password prompt failed" }
																		)

																		if (newPassword === null) {
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
																				edited?.expiration ?? publicLinkStatusQuery.data.status.expiration,
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
														value: edited?.downloadable ?? serverDownloadable,
														onValueChange: async () => {
															setEdited(prev => ({
																...(prev ?? {}),
																downloadable: !(prev?.downloadable ?? serverDownloadable)
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
												requiresOnline
												onPress={async () => {
													if (!isOnline) {
														return
													}

													const result = await runWithLoading(async () => {
														const held = recentHeldLinkStatus(publicLinkStatusQuery)

														return await drive.enablePublicLink({
															item: itemParsed,
															knownAbsent: held.current && held.value === null
														})
													})

													if (!result.success) {
														logger.error("publicLink", "failed to enable public link", { error: result.error, uuid: itemParsed.data.uuid })
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
					<LoadErrorEmpty
						title={t("could_not_load_link")}
						onRetry={() => {
							void publicLinkStatusQuery.refetch()
							void accountQuery.refetch()
						}}
					/>
				) : (
					<LoadingView />
				)}
			</ScreenBody>
		</Fragment>
	)
}

export default PublicLink
