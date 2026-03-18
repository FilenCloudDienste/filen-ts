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

const PreviewText = memo(({ fileUrl, previewType }: { fileUrl: string; previewType: ReturnType<typeof getPreviewType> }) => {
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()
	const bgBackground = useResolveClassNames("bg-background")
	const { theme } = useUniwind()

	const query = useQuery({
		queryKey: ["drivePreviewTextContent", fileUrl],
		queryFn: async () => {
			const response = await fetch(fileUrl)

			if (!response.ok) {
				throw new Error(`HTTP error: ${response.status}`)
			}

			return response.text()
		},
		gcTime: 0,
		staleTime: 0,
		refetchOnMount: "always",
		refetchOnWindowFocus: "always"
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
