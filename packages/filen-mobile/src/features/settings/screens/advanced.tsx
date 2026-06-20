import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import { Fragment } from "react"
import { Platform } from "react-native"
import { useNavigation } from "expo-router"
import { router } from "@/lib/router"
import { Image } from "expo-image"
import { run, formatBytes } from "@filen/utils"
import SettingsHeader from "@/components/ui/settingsHeader"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { shareTmpFile } from "@/lib/share"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import thumbnails from "@/lib/thumbnails"
import fileCache from "@/lib/fileCache"
import audioCache from "@/features/audio/audioCache"
import sandboxCache from "@/lib/sandboxCache"
import offline from "@/features/offline/offline"
import diagnostics from "@/features/settings/diagnostics"
import useCacheSizesQuery, { invalidateCacheSizesQuery } from "@/features/settings/queries/useCacheSizes.query"
import { useTranslation } from "react-i18next"
import i18n from "@/lib/i18n"
import { CONVERT_HEIC_TO_JPG_ENABLED_SECURE_STORE_KEY, DEFAULT_CONVERT_HEIC_TO_JPG_ENABLED } from "@/lib/imageConversion"
import { sweepTmpDir } from "@/lib/tmp"
import { sweepStrayDownloadFiles } from "@/lib/fsUtils"
import useTransfersStore from "@/features/transfers/store/useTransfers.store"
import useOfflineStore from "@/features/offline/store/useOffline.store"
import useCameraUploadStore from "@/features/cameraUpload/store/useCameraUpload.store"
import { useSecureStore } from "@/lib/secureStore"
import {
	TRANSFERS_FOREGROUND_SERVICE_ENABLED_SECURE_STORE_KEY,
	DEFAULT_TRANSFERS_FOREGROUND_SERVICE_ENABLED
} from "@/features/transfers/foregroundService"
import logger from "@/lib/logger"

const SIZE_LOADING_PLACEHOLDER = "…"

// The sweeps delete live .filendl partials and staging files if allowed to race a
// download/sync — gate on every store that can put one in flight. fileCache preview
// fills don't surface here; they are seconds-long and re-derivable, an accepted
// residual of the store-gated design.
function transfersOrSyncsActive(): boolean {
	return (
		useTransfersStore.getState().transfers.length > 0 || useOfflineStore.getState().syncing || useCameraUploadStore.getState().syncing
	)
}

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
			logger.warn("settings", "Failed to clear expo-image memory cache", { error: err })

			return false
		}),
		Image.clearDiskCache().catch(err => {
			logger.warn("settings", "Failed to clear expo-image disk cache", { error: err })

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
		logger.warn("settings", "clear cache confirmation prompt failed", { error: promptResult.error })
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
		logger.error("settings", "clear cache action failed", { error: result.error })
		alerts.error(result.error)

		return
	}

	alerts.normal(options.successMessage)

	await invalidateCacheSizesQuery()
}

function Advanced() {
	const navigation = useNavigation()
	const { t } = useTranslation()

	const cacheSizesQuery = useCacheSizesQuery()
	const sizes = cacheSizesQuery.data

	const [foregroundServiceEnabled, setForegroundServiceEnabled] = useSecureStore<boolean>(
		TRANSFERS_FOREGROUND_SERVICE_ENABLED_SECURE_STORE_KEY,
		DEFAULT_TRANSFERS_FOREGROUND_SERVICE_ENABLED
	)

	const [convertHeic, setConvertHeic] = useSecureStore<boolean>(
		CONVERT_HEIC_TO_JPG_ENABLED_SECURE_STORE_KEY,
		DEFAULT_CONVERT_HEIC_TO_JPG_ENABLED
	)

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

	const exportLogs = async () => {
		const promptResult = await run(async () => {
			return await prompts.alert({
				title: t("export_logs"),
				message: t("export_logs_consent"),
				okText: t("export_logs_action"),
				cancelText: i18n.t("cancel"),
				destructive: false
			})
		})

		if (!promptResult.success) {
			logger.warn("settings", "export logs confirmation prompt failed", { error: promptResult.error })
			alerts.error(promptResult.error)

			return
		}

		if (promptResult.data.cancelled) {
			return
		}

		// Prep (flush + zip) under the loading overlay...
		const result = await runWithLoading(async () => {
			return await diagnostics.prepareLogsExport()
		})

		if (!result.success) {
			logger.error("settings", "exportLogs prep failed", { error: result.error })
			alerts.error(result.error)

			return
		}

		if (result.data === "no-logs") {
			alerts.normal(t("export_logs_none"))

			return
		}

		// ...then open the share sheet OUTSIDE runWithLoading — the loading overlay must not cover the
		// native share sheet. shareTmpFile funnels through withSystemPresentation (privacy cover stays hidden).
		const shareResult = await shareTmpFile({
			uri: result.data.uri,
			name: result.data.name,
			mimeType: "application/zip",
			cleanup: result.data.cleanup
		})

		if (!shareResult.success) {
			logger.error("settings", "exportLogs share failed", { error: shareResult.error })
			alerts.error(shareResult.error)
		}
	}

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
				<SettingsScrollView>
					<Group
						className="bg-background-tertiary"
						buttons={[
							{
								icon: "swap-horizontal-outline",
								title: t("convert_heic_to_jpg"),
								subTitle: t("convert_heic_to_jpg_description"),
								rightItem: {
									type: "switch",
									value: convertHeic,
									onValueChange: () => {
										setConvertHeic(prev => !prev)
									}
								}
							}
						]}
					/>
					{Platform.OS === "android" ? (
						<Group
							className="bg-background-tertiary"
							buttons={[
								{
									icon: "notifications-outline",
									title: t("background_transfers"),
									subTitle: t("background_transfers_description"),
									rightItem: {
										type: "switch",
										value: foregroundServiceEnabled,
										onValueChange: () => {
											setForegroundServiceEnabled(prev => !prev)
										}
									}
								}
							]}
						/>
					) : null}
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
							},
							{
								// Display-only: the SDK search index isn't user-clearable (clearing it
								// just forces a full re-sync) and is wiped on logout. No onPress.
								icon: "search-outline",
								title: t("search_index"),
								subTitle: formatSize(sizes?.sdkCache)
							}
						]}
					/>
					<Group
						className="bg-background-tertiary"
						buttons={[
							{
								icon: "sparkles-outline",
								title: t("clean_temporary_files"),
								subTitle: t("clean_temporary_files_description"),
								onPress: () => {
									if (transfersOrSyncsActive()) {
										alerts.normal(t("clean_temporary_files_unavailable"))

										return
									}

									confirmAndRun({
										title: t("clean_temporary_files"),
										message: t("clean_temporary_files_confirmation"),
										action: async () => {
											// Re-check after the confirm prompt — a transfer or sync may
											// have started while the dialog was open.
											if (transfersOrSyncsActive()) {
												throw new Error(i18n.t("clean_temporary_files_unavailable"))
											}

											sweepTmpDir()
											sweepStrayDownloadFiles()
										},
										successMessage: t("temporary_files_cleaned")
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
								subTitleNumberOfLines: 1,
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
						<Group
							className="bg-background-tertiary"
							buttons={[
								{
									icon: "list-outline",
									title: t("view_logs"),
									subTitle: t("view_logs_description"),
									onPress: () => {
										router.push("/logViewer")
									}
								},
								{
									icon: "document-text-outline",
									title: t("export_logs"),
									subTitle: t("export_logs_description"),
									onPress: () => {
										exportLogs()
									}
								}
							]}
						/>
				</SettingsScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default Advanced
