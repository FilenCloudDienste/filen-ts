import { memo } from "@/lib/memo"
import View from "@/components/ui/view"
import { type getPreviewType } from "@/lib/utils"
import TextEditor, { backgroundColors } from "@/components/textEditor"
import { useQuery } from "@tanstack/react-query"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useResolveClassNames, useUniwind } from "uniwind"
import { fetch } from "expo/fetch"
import { DEFAULT_QUERY_OPTIONS_ETERNAL, useDefaultQueryParams } from "@/queries/client"

const PreviewText = memo(({ fileUrl, previewType }: { fileUrl: string; previewType: ReturnType<typeof getPreviewType> }) => {
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()
	const bgBackground = useResolveClassNames("bg-background")
	const { theme } = useUniwind()

	const defaultQueryParams = useDefaultQueryParams()
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS_ETERNAL,
		...defaultQueryParams,
		queryKey: ["drivePreviewTextContent", fileUrl],
		queryFn: async ({ signal }) => {
			const response = await fetch(fileUrl, {
				signal
			})

			if (!response.ok) {
				throw new Error(`HTTP error: ${response.status}`)
			}

			return response.text()
		}
	})

	if (query.status !== "success") {
		// TODO: show loading state or error message
		return null
	}

	return (
		<View
			className="flex-1"
			style={{
				backgroundColor:
					previewType === "text" ? bgBackground.backgroundColor : backgroundColors["normal"][theme === "dark" ? "dark" : "light"]
			}}
		>
			<TextEditor
				key={query.dataUpdatedAt}
				initialValue={query.data}
				onValueChange={() => {}}
				readOnly={true}
				placeholder="tbd_placeholder"
				type={previewType === "code" ? "code" : "text"}
				disableRichtextToolbar={true}
				paddingTop={headerHeight ? headerHeight + 8 : undefined}
				paddingBottom={insets.bottom}
			/>
		</View>
	)
})

export default PreviewText
