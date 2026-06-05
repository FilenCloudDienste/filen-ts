import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment } from "react"
import { useNavigation } from "expo-router"
import { Image } from "expo-image"
import { run, formatBytes } from "@filen/utils"
import SettingsHeader from "@/components/ui/settingsHeader"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import thumbnails from "@/lib/thumbnails"
import fileCache from "@/lib/fileCache"
import audioCache from "@/features/audio/audioCache"
import sandboxCache from "@/lib/sandboxCache"
import offline from "@/features/offline/offline"
import useCacheSizesQuery, { invalidateCacheSizesQuery } from "@/features/settings/queries/useCacheSizes.query"
import { useTranslation } from "react-i18next"
import i18n from "@/lib/i18n"

const SIZE_LOADING_PLACEHOLDER = "…"

function formatSize(value: number | undefined): string {
	if (typeof value !== "number") {
		return SIZE_LOADING_PLACEHOLDER
	}

	return formatBytes(value)
}

// Stale thumbnail file:// URIs may still be held in expo-image's caches after the underlying
// files are deleted — invalidate both layers so the next render fetches fresh bytes.
async function clearExpoImageCache(): Promise<void> {
	await Promise.all([
		Image.clearMemoryCache().catch(err => {
			console.error("[Advanced] Failed to clear expo-image memory cache", err)

			return false
		}),
		Image.clearDiskCache().catch(err => {
			console.error("[Advanced] Failed to clear expo-image disk cache", err)

			return false
		})
	])
}

async function confirmAndRun(options: {
	title: string
	message: string
	action: () => Promise<void>
	successMessage: string
}): Promise<void> {
	const promptResult = await run(async () => {
		return await prompts.alert({
			title: options.title,
			message: options.message,
			okText: i18n.t("clear"),
			cancelText: i18n.t("cancel"),
			destructive: true
		})
	})

	if (!promptResult.success) {
		console.error(promptResult.error)
		alerts.error(promptResult.error)

		return
	}

	if (promptResult.data.cancelled) {
		return
	}

	const result = await runWithLoading(async () => {
		await options.action()
	})

	if (!result.success) {
		console.error(result.error)
		alerts.error(result.error)

		return
	}

	alerts.normal(options.successMessage)

	await invalidateCacheSizesQuery()
}

function Advanced() {
	const insets = useSafeAreaInsets()
	const navigation = useNavigation()
	const { t } = useTranslation()

	const cacheSizesQuery = useCacheSizesQuery()
	const sizes = cacheSizesQuery.data

	const offlineSubtitle = (() => {
		if (!sizes) {
			return SIZE_LOADING_PLACEHOLDER
		}

		return `${formatBytes(sizes.offline.size)} · ${t("offline_files_count", {
			count: sizes.offline.files
		})}, ${t("offline_dirs_count", {
			count: sizes.offline.dirs
		})}`
	})()

	return (
		<Fragment>
			<SettingsHeader
				title={t("advanced")}
				icon="close"
				onDismiss={() => {
					navigation.getParent()?.goBack()
				}}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
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
								icon: "image-outline",
								title: t("clear_image_thumbnails"),
								subTitle: formatSize(sizes?.thumbnails),
								onPress: () => {
									confirmAndRun({
										title: t("clear_image_thumbnails"),
										message: t("clear_image_thumbnails_description"),
										action: async () => {
											await thumbnails.clear()

											await clearExpoImageCache()
										},
										successMessage: t("image_thumbnails_cleared")
									})
								}
							},
							{
								icon: "film-outline",
								title: t("clear_preview_cache"),
								subTitle: formatSize(sizes?.fileCache),
								onPress: () => {
									confirmAndRun({
										title: t("clear_preview_cache"),
										message: t("clear_preview_cache_description"),
										action: async () => {
											await fileCache.clear()

											await clearExpoImageCache()
										},
										successMessage: t("preview_cache_cleared")
									})
								}
							},
							{
								icon: "musical-notes-outline",
								title: t("clear_music_metadata"),
								subTitle: formatSize(sizes?.audioCache),
								onPress: () => {
									confirmAndRun({
										title: t("clear_music_metadata"),
										message: t("clear_music_metadata_description"),
										action: () => audioCache.clear(),
										successMessage: t("music_metadata_cleared")
									})
								}
							},
							{
								icon: "folder-open-outline",
								title: t("clear_sandbox_cache"),
								subTitle: formatSize(sizes?.sandbox),
								onPress: () => {
									confirmAndRun({
										title: t("clear_sandbox_cache"),
										message: t("clear_sandbox_cache_description"),
										action: async () => {
											await sandboxCache.clear()

											await clearExpoImageCache()
										},
										successMessage: t("sandbox_cache_cleared")
									})
								}
							},
							{
								icon: "trash-outline",
								title: t("clear_all_disk_caches"),
								subTitle: t("clear_all_disk_caches_description"),
								onPress: () => {
									confirmAndRun({
										title: t("clear_all_disk_caches"),
										message: t("clear_all_disk_caches_confirmation"),
										action: async () => {
											// Independent disk operations — run in parallel and surface a
											// partial failure only after each gets a chance to complete.
											const results = await Promise.allSettled([
												thumbnails.clear(),
												fileCache.clear(),
												audioCache.clear(),
												sandboxCache.clear()
											])

											await clearExpoImageCache()

											const firstFailure = results.find(r => r.status === "rejected")

											if (firstFailure && firstFailure.status === "rejected") {
												throw firstFailure.reason
											}
										},
										successMessage: t("all_disk_caches_cleared")
									})
								}
							}
						]}
					/>
					<Group
						className="bg-background-tertiary"
						buttons={[
							{
								icon: "cloud-offline-outline",
								iconColor: "#ef4444",
								title: t("clear_offline_files"),
								subTitle: offlineSubtitle,
								onPress: () => {
									confirmAndRun({
										title: t("clear_offline_files"),
										message: t("clear_offline_files_confirmation"),
										action: async () => {
											await offline.clearAll()

											await clearExpoImageCache()
										},
										successMessage: t("offline_files_cleared")
									})
								}
							}
						]}
					/>
				</GestureHandlerScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default Advanced
