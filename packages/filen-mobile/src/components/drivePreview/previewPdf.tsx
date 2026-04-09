import { memo, useRef } from "react"
import { ActivityIndicator } from "react-native"
import View from "@/components/ui/view"
import { useSimpleQuery } from "@/hooks/useSimpleQuery"
import { DriveItemFileExtracted } from "@/types"
import fileCache from "@/lib/fileCache"
import { PdfView, type OnErrorEventPayload } from "@kishannareshpal/expo-pdf"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useShallow } from "zustand/shallow"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import offline from "@/lib/offline"
import { useRecyclingState } from "@shopify/flash-list"
import Button from "@/components/ui/button"

const PreviewPdf = memo(({ item }: { item: DriveItemFileExtracted }) => {
	const [password, setPassword] = useRecyclingState<string | null>(null, [item.data.uuid])
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()
	const onErrorWorkingRef = useRef<boolean>(false)
	const [didCancelPasswordPrompt, setDidCancelPasswordPrompt] = useRecyclingState<boolean>(false, [item.data.uuid])

	const query = useSimpleQuery(async signal => {
		const isStoredOffline = await offline.isItemStored(item)

		if (isStoredOffline) {
			const file = await offline.getLocalFile(item)

			if (file) {
				return file
			}
		}

		const file = await fileCache.get({
			item,
			signal
		})

		return file
	})

	const promptPassword = async () => {
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

			setDidCancelPasswordPrompt(true)

			return
		}

		if (result.data.cancelled || result.data.type !== "string") {
			setDidCancelPasswordPrompt(true)

			return
		}

		const password = result.data.value.trim()

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
					alerts.error("tbd_invalid_pdf")

					return
				}

				case "invalid_uri": {
					alerts.error("tbd_unable_to_load_pdf")

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
					<Button onPress={() => promptPassword()}>tbd_enter_pdf_password</Button>
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
})

export default PreviewPdf
