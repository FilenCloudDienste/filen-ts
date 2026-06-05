import { useRef } from "react"
import { useTranslation } from "react-i18next"
import { ActivityIndicator } from "react-native"
import View from "@/components/ui/view"
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

	if (query.status !== "success") {
		return (
			<View className="bg-background flex-1 items-center justify-center">
				<ActivityIndicator
					size="small"
					color="white"
				/>
			</View>
		)
	}

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

export default PreviewPdf
