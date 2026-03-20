import { memo, useMemo } from "@/lib/memo"
import View from "@/components/ui/view"
import { getPreviewType } from "@/lib/utils"
import TextEditor, { backgroundColors } from "@/components/textEditor"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useResolveClassNames, useUniwind } from "uniwind"
import { ActivityIndicator } from "react-native"
import { useSimpleQuery } from "@/hooks/useSimpleQuery"
import fileCache from "@/lib/fileCache"
import type { DriveItemFileExtracted } from "@/types"

const PreviewText = memo(({ item }: { item: DriveItemFileExtracted }) => {
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()
	const bgBackground = useResolveClassNames("bg-background")
	const { theme } = useUniwind()

	const previewType = useMemo(() => {
		return getPreviewType(item.data.decryptedMeta?.name ?? "")
	}, [item.data.decryptedMeta])

	const query = useSimpleQuery(async signal => {
		const file = await fileCache.get({
			item,
			signal
		})

		return await file.text()
	})

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
		<View
			className="flex-1"
			style={{
				backgroundColor:
					previewType === "text" ? bgBackground.backgroundColor : backgroundColors["normal"][theme === "dark" ? "dark" : "light"]
			}}
		>
			<TextEditor
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
