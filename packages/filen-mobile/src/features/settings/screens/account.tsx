import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment } from "react"
import { useNavigation } from "expo-router"
import { run, cn } from "@filen/utils"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform, ActivityIndicator } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Text from "@/components/ui/text"
import useAccountQuery from "@/queries/useAccount.query"
import { buildDangerZoneButtons, buildProfileButtons, buildAccountToggleButtons, buildLogoutButtons } from "@/features/settings/accountButtons"
import { PressableScale } from "@/components/ui/pressables"
import Avatar from "@/components/ui/avatar"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import auth from "@/lib/auth"
import * as ImagePicker from "expo-image-picker"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import useIsOnline from "@/hooks/useIsOnline"
import { useTranslation } from "react-i18next"
import { prepareAvatarFileForUpload } from "@/features/settings/avatarUpload"

function Account() {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const navigation = useNavigation()
	const textRed500 = useResolveClassNames("text-red-500")
	const isOnline = useIsOnline()
	const { t } = useTranslation()

	const accountQuery = useAccountQuery()

	return (
		<Fragment>
			<Header
				title={t("account")}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={() => {
					if (Platform.OS === "android") {
						return null
					}

					return [
						{
							type: "button",
							icon: {
								name: "close",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									navigation.getParent()?.goBack()
								}
							}
						}
					]
				}}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				{accountQuery.status !== "success" ? (
					<View className="flex-1 bg-transparent items-center justify-center">
						<ActivityIndicator
							size="large"
							color={textForeground.color as string}
						/>
					</View>
				) : (
					<GestureHandlerScrollView
						className="bg-transparent flex-1"
						contentInsetAdjustmentBehavior="automatic"
						contentContainerClassName="px-4 gap-4"
						showsHorizontalScrollIndicator={false}
						contentContainerStyle={{
							paddingBottom: insets.bottom
						}}
					>
						<PressableScale
							className={cn(
								"bg-background-tertiary rounded-3xl overflow-hidden flex-row gap-4 items-center p-4",
								!isOnline && "opacity-50"
							)}
							rippleColor="transparent"
							onPress={async () => {
								if (!isOnline) {
									return
								}

								const permissionsResult = await run(async () => {
									return await hasAllNeededMediaPermissions({
										shouldRequest: true
									})
								})

								if (!permissionsResult.success) {
									console.error(permissionsResult.error)
									alerts.error(permissionsResult.error)

									return
								}

								if (!permissionsResult.data) {
									alerts.error(t("no_permissions_enable_manually"))

									return
								}

								const imagePickerResult = await run(async () => {
									return await ImagePicker.launchImageLibraryAsync({
										mediaTypes: ["images"],
										exif: false,
										base64: false,
										quality: 1,
										allowsMultipleSelection: false,
										allowsEditing: true,
										presentationStyle: ImagePicker.UIImagePickerPresentationStyle.PAGE_SHEET,
										shouldDownloadFromNetwork: true
									})
								})

								if (!imagePickerResult.success) {
									console.error(imagePickerResult.error)
									alerts.error(imagePickerResult.error)

									return
								}

								if (imagePickerResult.data.canceled) {
									return
								}

								const asset = imagePickerResult.data.assets[0]

								if (!asset) {
									return
								}

								const result = await runWithLoading(async defer => {
									const fileToUpload = await prepareAvatarFileForUpload({ asset, defer })
									const { authedSdkClient } = await auth.getSdkClients()
									await authedSdkClient.uploadAvatar(await fileToUpload.arrayBuffer())
									await accountQuery.refetch()
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}
							}}
						>
							<Avatar
								size={22}
								source={accountQuery.data.avatarUrl}
							/>
							<Text
								numberOfLines={1}
								ellipsizeMode="middle"
								className="text-sm flex-1"
							>
								{t("change_avatar")}
							</Text>
							<Ionicons
								name="chevron-forward-outline"
								size={20}
								color={textMutedForeground.color}
							/>
						</PressableScale>
						<Group
							className="bg-background-tertiary"
							buttons={buildProfileButtons({ t, accountQuery, isOnline })}
						/>
						<Group
							className="bg-background-tertiary"
							buttons={buildAccountToggleButtons({ t, accountQuery, isOnline })}
						/>
						<Group
							className="bg-background-tertiary"
							buttons={buildLogoutButtons({ t })}
						/>
						<View className="bg-transparent gap-2">
							<View className="bg-transparent flex-row items-center gap-2 px-2">
								<Text className="text-xs font-semibold uppercase tracking-wider text-red-500">{t("danger_zone")}</Text>
							</View>
							<Group
								className="bg-background-tertiary"
								buttons={buildDangerZoneButtons({ t, accountQuery, isOnline, textRed500 })}
							/>
						</View>
					</GestureHandlerScrollView>
				)}
			</SafeAreaView>
		</Fragment>
	)
}

export default Account
