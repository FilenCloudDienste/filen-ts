import Text from "@/components/ui/text"
import { Platform } from "react-native"
import { router } from "@/lib/router"
import View from "@/components/ui/view"
import SafeAreaView from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import Header, { type HeaderItem } from "@/components/ui/header"
import { type MenuButton } from "@/components/ui/menu"
import { Fragment } from "react"
import { useResolveClassNames } from "uniwind"
import VirtualList from "@/components/ui/virtualList"
import { PressableOpacity } from "@/components/ui/pressables"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useCameraUploadStore, {
	type CameraUploadError,
	type CameraUploadSkippedAsset
} from "@/features/cameraUpload/store/useCameraUpload.store"
import { useShallow } from "zustand/shallow"
import { unwrapSdkError, unwrappedSdkErrorToHumanReadable } from "@/lib/sdkErrors"
import logger from "@/lib/logger"
import cameraUpload from "@/features/cameraUpload/cameraUpload"
import { useTranslation } from "react-i18next"

// The combined "camera upload issues" modal renders two logically distinct sections (errors +
// skipped assets) through one VirtualList. Each visible item is one of these tagged rows; the
// section headers are rows too so the whole list scrolls together and recycles cleanly.
type Row =
	| { type: "section"; id: string; title: string }
	| { type: "error"; id: string; error: CameraUploadError }
	| { type: "skipped"; id: string; asset: CameraUploadSkippedAsset }

const SectionHeader = ({ title }: { title: string }) => {
	return (
		<View className="px-4 pt-5 pb-1 bg-transparent">
			<Text className="text-sm text-muted-foreground uppercase">{title}</Text>
		</View>
	)
}

const ErrorRow = ({ error }: { error: CameraUploadError }) => {
	const { t } = useTranslation()

	const errorMessage = (() => {
		if (!error.error) {
			return t("unknown_error")
		}

		const unwrappedError = unwrapSdkError(error.error)

		if (unwrappedError) {
			return unwrappedSdkErrorToHumanReadable(unwrappedError)
		}

		if (error.error instanceof Error) {
			return (error.error as Error).message
		}

		if (typeof error.error === "string") {
			return error.error
		}

		return t("unknown_error")
	})()

	return (
		<View className="flex-row items-center px-4 bg-transparent flex-1">
			<View className="flex-row items-center py-3 border-b border-separator flex-1 bg-transparent">
				<Text>{errorMessage}</Text>
			</View>
		</View>
	)
}

const SkippedRow = ({ asset }: { asset: CameraUploadSkippedAsset }) => {
	const { t } = useTranslation()

	return (
		<View className="flex-row items-center px-4 bg-transparent flex-1">
			<View className="flex-row items-center gap-3 py-3 border-b border-separator flex-1 bg-transparent">
				<View className="flex-1 bg-transparent">
					<Text
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{asset.name}
					</Text>
					<Text className="text-xs text-muted-foreground">{t("camera_upload_skipped_asset_description")}</Text>
				</View>
				<PressableOpacity
					hitSlop={8}
					onPress={() => {
						cameraUpload.retrySkippedAsset(asset.id)
					}}
				>
					<Text className="text-base font-medium text-primary">{t("retry")}</Text>
				</PressableOpacity>
			</View>
		</View>
	)
}

const CameraUploadErrors = () => {
	const { t } = useTranslation()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const errors = useCameraUploadStore(useShallow(state => state.errors))
	const skippedAssets = useCameraUploadStore(useShallow(state => state.skippedAssets))

	const rows: Row[] = []

	if (errors.length > 0) {
		rows.push({
			type: "section",
			id: "section-errors",
			title: t("camera_upload_errors_section")
		})

		for (const error of errors) {
			rows.push({
				type: "error",
				id: `error-${error.id}`,
				error
			})
		}
	}

	if (skippedAssets.length > 0) {
		rows.push({
			type: "section",
			id: "section-skipped",
			title: t("camera_upload_skipped_section")
		})

		for (const asset of skippedAssets) {
			rows.push({
				type: "skipped",
				id: `skipped-${asset.id}`,
				asset
			})
		}
	}

	const menuButtons: MenuButton[] = []

	if (errors.length > 0) {
		menuButtons.push({
			id: "clear",
			icon: "trash",
			title: t("clear_errors"),
			onPress: () => {
				useCameraUploadStore.getState().setErrors([])

				cameraUpload
					.sync({ manual: true })
					.catch(err => logger.warn("cameraUpload", "Sync after clearing errors failed", { error: err }))
			}
		})
	}

	if (skippedAssets.length > 0) {
		menuButtons.push({
			id: "retryAll",
			icon: "restore",
			title: t("retry_all"),
			onPress: () => {
				cameraUpload.retryAllSkippedAssets()
			}
		})
	}

	menuButtons.push({
		id: "settings",
		icon: "gear",
		title: t("settings"),
		onPress: () => {
			router.push("/cameraUpload")
		}
	})

	return (
		<Fragment>
			<Header
				title={t("camera_upload_issues")}
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
									router.back()
								}
							}
						}
					] satisfies HeaderItem[],
					default: undefined
				})}
				rightItems={[
					{
						type: "menu",
						props: {
							type: "dropdown",
							hitSlop: 20,
							buttons: menuButtons
						},
						triggerProps: {
							hitSlop: 20
						},
						icon: {
							name: "ellipsis-horizontal",
							size: 24,
							color: textForeground.color
						}
					}
				]}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<VirtualList<Row>
					data={rows}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
					getItemType={row => row.type}
					emptyComponent={() => (
						<ListEmpty
							icon="checkmark-outline"
							title={t("no_camera_upload_errors")}
							description={t("no_camera_upload_errors_description")}
						/>
					)}
					renderItem={({ item: row }) => {
						switch (row.type) {
							case "section": {
								return <SectionHeader title={row.title} />
							}

							case "error": {
								return <ErrorRow error={row.error} />
							}

							case "skipped": {
								return <SkippedRow asset={row.asset} />
							}

							default: {
								return null
							}
						}
					}}
					keyExtractor={row => row.id}
				/>
			</SafeAreaView>
		</Fragment>
	)
}

export default CameraUploadErrors
