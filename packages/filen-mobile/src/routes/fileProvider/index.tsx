import SafeAreaView from "@/components/ui/safeAreaView"
import { Group, type Button } from "@/routes/tabs/more"
import { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment, memo } from "react"
import { router } from "expo-router"
import { run, formatBytes } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import { useSecureStore } from "@/lib/secureStore"
import fileProvider, { FILE_PROVIDER_ENABLED_SECURE_STORE_KEY } from "@/lib/fileProvider"
import { type Biometric } from "@/routes/security/biometric"
import Text from "@/components/ui/text"
import useDeviceDiskSpace from "@/hooks/useDeviceDiskSpace"
import useFileProviderCacheBudgetQuery, { invalidateFileProviderCacheBudgetQuery } from "@/queries/useFileProviderCacheBudget.query"
import { actionSheet } from "@/providers/actionSheet.provider"

const FILE_PROVIDER_FEATURE_LABEL = Platform.OS === "ios" ? "tbd_file_provider" : "tbd_documents_provider"
const FILE_PROVIDER_FEATURE_DESCRIPTION = Platform.OS === "ios" ? "tbd_file_provider_description" : "tbd_documents_provider_description"

const CACHE_SIZE_PRESETS_BYTES: readonly number[] = [
	256 * 1024 * 1024,
	512 * 1024 * 1024,
	1 * 1024 * 1024 * 1024,
	2 * 1024 * 1024 * 1024,
	5 * 1024 * 1024 * 1024,
	10 * 1024 * 1024 * 1024,
	25 * 1024 * 1024 * 1024,
	50 * 1024 * 1024 * 1024
]

// Headroom we never let the user encroach on. Leaves room for OS, user files,
// the cache's own DB + temp staging, and unrelated app churn.
const CACHE_SIZE_SAFETY_BUFFER_BYTES = 1024 * 1024 * 1024

const FileProviderSettings = memo(() => {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const [enabled, setEnabled] = useSecureStore<boolean>(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY, false)
	const [biometric, setBiometric] = useSecureStore<Biometric>("biometric", {
		enabled: false
	})
	const { availableBytes } = useDeviceDiskSpace()
	const cacheBudgetQuery = useFileProviderCacheBudgetQuery({ enabled })
	const currentCacheBudgetBytes = cacheBudgetQuery.data

	const groupButtons: Button[] = [
		{
			icon: "folder-open-outline",
			title: FILE_PROVIDER_FEATURE_LABEL,
			rightItem: {
				type: "switch",
				value: enabled,
				onValueChange: async (next: boolean) => {
					if (!next) {
						const result = await run(async () => {
							await fileProvider.disable()
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}

						setEnabled(false)

						return
					}

					// Enabling. If biometric is currently on, warn the user that
					// turning the provider on disables biometric (the native
					// extensions read auth.json directly and bypass the JS
					// biometric gate — keeping both on would only create a
					// false sense of security).
					if (biometric.enabled) {
						const confirmResult = await run(async () => {
							return await prompts.alert({
								title: "tbd_file_provider_disables_biometric_title",
								message: "tbd_file_provider_disables_biometric_message",
								okText: "tbd_continue",
								cancelText: "tbd_cancel",
								destructive: true
							})
						})

						if (!confirmResult.success) {
							console.error(confirmResult.error)
							alerts.error(confirmResult.error)

							return
						}

						if (confirmResult.data.cancelled) {
							return
						}

						setBiometric({
							enabled: false
						})
					}

					const enableResult = await run(async () => {
						await fileProvider.enable()
					})

					if (!enableResult.success) {
						console.error(enableResult.error)
						alerts.error(enableResult.error)

						return
					}

					setEnabled(true)
				}
			}
		}
	]

	if (enabled) {
		groupButtons.push({
			icon: "server-outline",
			title: "tbd_cache_size",
			subTitle: "tbd_cache_size_description",
			rightItem: {
				type: "text",
				value: typeof currentCacheBudgetBytes === "number" ? formatBytes(currentCacheBudgetBytes) : "…"
			},
			onPress: () => {
				// Defense-in-depth: re-check enabled at click time in case the user
				// toggled off via the switch above while the row was still on screen.
				if (!enabled || typeof currentCacheBudgetBytes !== "number") {
					return
				}

				const cap = availableBytes - CACHE_SIZE_SAFETY_BUFFER_BYTES
				const feasible = CACHE_SIZE_PRESETS_BYTES.filter(p => p <= cap)
				const valueSet = new Set<number>(feasible)

				// Always include the current value — even if it exceeds free space now —
				// so the user always sees what they have set today.
				valueSet.add(currentCacheBudgetBytes)

				const sorted = Array.from(valueSet).sort((a, b) => a - b)

				actionSheet.show({
					buttons: [
						...sorted.map(bytes => {
							const title = bytes === currentCacheBudgetBytes ? `${formatBytes(bytes)} (tbd_current)` : formatBytes(bytes)

							return {
								title,
								onPress: async () => {
									if (bytes === currentCacheBudgetBytes) {
										return
									}

									const result = await run(async () => {
										await fileProvider.setCacheBudget(bytes)
										await invalidateFileProviderCacheBudgetQuery()
									})

									if (!result.success) {
										console.error(result.error)
										alerts.error(result.error)
									}
								}
							}
						}),
						{
							title: "tbd_close",
							cancel: true
						}
					]
				})
			}
		})
	}

	return (
		<Fragment>
			<Header
				title={FILE_PROVIDER_FEATURE_LABEL}
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
									if (router.canGoBack()) {
										router.back()
									}
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
					contentContainerClassName="px-4 gap-2"
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
				>
					<Group
						className="bg-background-tertiary"
						buttons={groupButtons}
					/>
					<Text className="text-sm text-muted-foreground px-4 leading-5">{FILE_PROVIDER_FEATURE_DESCRIPTION}</Text>
				</GestureHandlerScrollView>
			</SafeAreaView>
		</Fragment>
	)
})

export default FileProviderSettings
