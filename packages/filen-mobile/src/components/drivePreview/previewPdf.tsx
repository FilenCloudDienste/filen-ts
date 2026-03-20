import { memo, useCallback, useMemo } from "@/lib/memo"
import { ActivityIndicator } from "react-native"
import View from "@/components/ui/view"
import { useSimpleQuery } from "@/hooks/useSimpleQuery"
import { DriveItemFileExtracted } from "@/types"
import fileCache from "@/lib/fileCache"
import { PdfView, type OnErrorEventPayload } from "@kishannareshpal/expo-pdf"
import { useState, useRef } from "react"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useShallow } from "zustand/shallow"
import { useSafeAreaInsets } from "react-native-safe-area-context"

const pdfViewStyle = {
	flex: 1,
	backgroundColor: "transparent"
}

const PreviewPdf = memo(({ item }: { item: DriveItemFileExtracted }) => {
	const [password, setPassword] = useState<string | null>(null)
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()
	const onErrorWorkingRef = useRef<boolean>(false)

	const query = useSimpleQuery(signal =>
		fileCache.get({
			item,
			signal
		})
	)

	const contentPadding = useMemo(
		() => ({
			top: headerHeight ?? 0,
			bottom: insets.bottom
		}),
		[headerHeight, insets.bottom]
	)

	const onError = useCallback(async (e: OnErrorEventPayload) => {
		await run(async defer => {
			if (onErrorWorkingRef.current) {
				return
			}

			onErrorWorkingRef.current = true

			defer(() => {
				onErrorWorkingRef.current = false
			})

			switch (e.code) {
				case "invalid_document": {
					alerts.error("tbd_invalid_pdf")

					return
				}

				case "invalid_uri": {
					alerts.error("tbd_unable_to_load_pdf")

					return
				}

				case "password_incorrect":
				case "password_required": {
					if (e.code === "password_incorrect") {
						alerts.error("tbd_incorrect_password")
					}

					const result = await run(async () => {
						return await prompts.input({
							title: "tbd_password_required",
							message: "tbd_enter_password",
							cancelText: "tbd_cancel",
							okText: "tbd_ok",
							inputType: "secure-text"
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}

					if (result.data.cancelled || result.data.type !== "string") {
						return
					}

					const password = result.data.value.trim()

					if (password.length === 0) {
						return
					}

					setPassword(password)
				}
			}
		})
	}, [])

	if (query.status !== "success") {
		return (
			<View className="bg-transparent flex-1 items-center justify-center">
				<ActivityIndicator
					size="small"
					color="white"
				/>
			</View>
		)
	}

	return (
		<View className="bg-background flex-1">
			<PdfView
				style={pdfViewStyle}
				contentPadding={contentPadding}
				password={password ?? undefined}
				doubleTapToZoom={true}
				autoScale={false}
				fitMode="both"
				uri={query.data.uri}
				onError={onError}
			/>
		</View>
	)
})

export default PreviewPdf
