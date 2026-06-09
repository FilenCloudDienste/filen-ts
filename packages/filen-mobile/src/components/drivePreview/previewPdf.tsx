import { useRef } from "react"
import { useTranslation } from "react-i18next"
import { ActivityIndicator } from "react-native"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import useFileUriQuery from "@/queries/useFileUri.query"
import { PdfView, type OnErrorEventPayload } from "@kishannareshpal/expo-pdf"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useShallow } from "zustand/shallow"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useRecyclingState } from "@shopify/flash-list"
import Button from "@/components/ui/button"
import { type GalleryItemTagged, galleryItemKey } from "@/components/drivePreview/gallery"

const PreviewPdf = ({ item }: { item: GalleryItemTagged }) => {
	const { t } = useTranslation()
	const [password, setPassword] = useRecyclingState<string | null>(null, [galleryItemKey(item)])
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()
	const onErrorWorkingRef = useRef<boolean>(false)
	const [didCancelPasswordPrompt, setDidCancelPasswordPrompt] = useRecyclingState<boolean>(false, [galleryItemKey(item)])

	const query = useFileUriQuery(
		item.type === "external"
			? {
					type: "external",
					data: {
						url: item.data.url,
						name: item.data.name
					}
				}
			: {
					type: "drive",
					data: {
						uuid: item.data.data.uuid
					}
				}
	)

	const promptPassword = async () => {
		const result = await run(async () => {
			return await prompts.input({
				title: t("password_required"),
				message: t("enter_the_password"),
				cancelText: t("cancel"),
				okText: t("ok"),
				inputType: "secure-text"
			})
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)

			setDidCancelPasswordPrompt(true)

			return
		}

		if (result.data.cancelled || result.data.type !== "string") {
			setDidCancelPasswordPrompt(true)

			return
		}

		const password = result.data.value

		if (password.length === 0) {
			setDidCancelPasswordPrompt(true)

			return
		}

		setPassword(password)
	}

	const onError = (e: OnErrorEventPayload) => {
		run(async defer => {
			if (onErrorWorkingRef.current) {
				return
			}

			onErrorWorkingRef.current = true

			defer(() => {
				onErrorWorkingRef.current = false
			})

			switch (e.code) {
				case "invalid_document": {
					alerts.error(t("invalid_pdf"))

					return
				}

				case "invalid_uri": {
					alerts.error(t("unable_to_load_pdf"))

					return
				}

				case "password_incorrect":
				case "password_required": {
					await promptPassword()

					break
				}
			}
		})
	}

	if (query.status === "pending" && query.fetchStatus === "fetching") {
		return (
			<View className="bg-background flex-1 items-center justify-center">
				<ActivityIndicator
					size="small"
					color="white"
				/>
			</View>
		)
	}

	if (query.fetchStatus === "paused") {
		return (
			<View className="bg-background flex-1 items-center justify-center px-8">
				<Ionicons
					name="cloud-offline-outline"
					size={48}
					color="#9ca3af"
				/>
				<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{t("unavailable_offline")}</Text>
			</View>
		)
	}

	if (query.status === "error") {
		return (
			<View className="bg-background flex-1 items-center justify-center px-8">
				<Ionicons
					name="warning-outline"
					size={48}
					color="#9ca3af"
				/>
				<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{t("preview_load_failed")}</Text>
				<PressableScale
					className="mt-4"
					onPress={() => query.refetch()}
					hitSlop={10}
				>
					<Text className="text-sm leading-5 text-primary">{t("retry")}</Text>
				</PressableScale>
			</View>
		)
	}

	if (query.status === "success") {
		return (
			<View className="bg-background flex-1">
				{didCancelPasswordPrompt ? (
					<View className="flex-1 bg-transparent items-center justify-center">
						<Button onPress={() => promptPassword()}>{t("enter_pdf_password")}</Button>
					</View>
				) : (
					<PdfView
						key={password ?? "no-password"}
						style={{
							flex: 1,
							backgroundColor: "transparent"
						}}
						contentPadding={{
							top: headerHeight ?? 0,
							bottom: insets.bottom
						}}
						password={password ?? undefined}
						doubleTapToZoom={true}
						autoScale={false}
						fitMode="both"
						uri={query.data.uri}
						onError={onError}
					/>
				)}
			</View>
		)
	}

	return (
		<View className="bg-background flex-1 items-center justify-center">
			<ActivityIndicator
				size="small"
				color="white"
			/>
		</View>
	)
}

export default PreviewPdf
