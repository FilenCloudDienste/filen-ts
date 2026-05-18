import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/routes/tabs/more"
import { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment, memo } from "react"
import { useNavigation } from "expo-router"
import { Image } from "expo-image"
import { run, formatBytes } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import thumbnails from "@/lib/thumbnails"
import fileCache from "@/lib/fileCache"
import audioCache from "@/lib/audioCache"
import sandboxCache from "@/lib/sandboxCache"
import offline from "@/lib/offline"
import useCacheSizesQuery, { invalidateCacheSizesQuery } from "@/queries/useCacheSizes.query"

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
			okText: "tbd_clear",
			cancelText: "tbd_cancel",
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

const Advanced = memo(() => {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const navigation = useNavigation()

	const cacheSizesQuery = useCacheSizesQuery()
	const sizes = cacheSizesQuery.data

	const offlineSubtitle = (() => {
		if (!sizes) {
			return SIZE_LOADING_PLACEHOLDER
		}

		return `${formatBytes(sizes.offline.size)} · ${sizes.offline.files} tbd_files, ${sizes.offline.dirs} tbd_dirs`
	})()

	return (
		<Fragment>
			<Header
				title="tbd_advanced"
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
								name: "close-outline",
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
								title: "tbd_clear_image_thumbnails",
								subTitle: formatSize(sizes?.thumbnails),
								onPress: () => {
									confirmAndRun({
										title: "tbd_clear_image_thumbnails",
										message: "tbd_clear_image_thumbnails_description",
										action: async () => {
											await thumbnails.clear()

											await clearExpoImageCache()
										},
										successMessage: "tbd_image_thumbnails_cleared"
									})
								}
							},
							{
								icon: "film-outline",
								title: "tbd_clear_preview_cache",
								subTitle: formatSize(sizes?.fileCache),
								onPress: () => {
									confirmAndRun({
										title: "tbd_clear_preview_cache",
										message: "tbd_clear_preview_cache_description",
										action: async () => {
											await fileCache.clear()

											await clearExpoImageCache()
										},
										successMessage: "tbd_preview_cache_cleared"
									})
								}
							},
							{
								icon: "musical-notes-outline",
								title: "tbd_clear_music_metadata",
								subTitle: formatSize(sizes?.audioCache),
								onPress: () => {
									confirmAndRun({
										title: "tbd_clear_music_metadata",
										message: "tbd_clear_music_metadata_description",
										action: () => audioCache.clear(),
										successMessage: "tbd_music_metadata_cleared"
									})
								}
							},
							{
								icon: "folder-open-outline",
								title: "tbd_clear_sandbox_cache",
								subTitle: formatSize(sizes?.sandbox),
								onPress: () => {
									confirmAndRun({
										title: "tbd_clear_sandbox_cache",
										message: "tbd_clear_sandbox_cache_description",
										action: async () => {
											sandboxCache.clear()

											await clearExpoImageCache()
										},
										successMessage: "tbd_sandbox_cache_cleared"
									})
								}
							},
							{
								icon: "trash-outline",
								title: "tbd_clear_all_disk_caches",
								subTitle: "tbd_clear_all_disk_caches_description",
								onPress: () => {
									confirmAndRun({
										title: "tbd_clear_all_disk_caches",
										message: "tbd_clear_all_disk_caches_confirmation",
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
										successMessage: "tbd_all_disk_caches_cleared"
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
								title: "tbd_clear_offline_files",
								subTitle: offlineSubtitle,
								onPress: () => {
									confirmAndRun({
										title: "tbd_clear_offline_files",
										message: "tbd_clear_offline_files_confirmation",
										action: async () => {
											await offline.clearAll()

											await clearExpoImageCache()
										},
										successMessage: "tbd_offline_files_cleared"
									})
								}
							}
						]}
					/>
				</GestureHandlerScrollView>
			</SafeAreaView>
		</Fragment>
	)
})

export default Advanced
