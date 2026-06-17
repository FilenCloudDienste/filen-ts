import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { formatBytes } from "@filen/utils"
import { useTranslation } from "react-i18next"
import { useResolveClassNames } from "uniwind"
import { computeStorageSegments } from "@/features/settings/storageSegments"

// Segmented storage bar + wrapping legend for the More-screen account header. Files is colored by
// fullness (green → yellow → red), versioned is a fixed blue, free is the track. Colors are resolved
// to inline styles (the proven pattern in this app for dynamic colors) rather than dynamic
// classNames. Display-only; lives inside the account card that routes to /account.
const StorageUsageBar = ({
	storageUsed,
	versionedStorage,
	maxStorage
}: {
	storageUsed: bigint
	versionedStorage: bigint
	maxStorage: bigint
}) => {
	const { t } = useTranslation()
	const green = useResolveClassNames("text-green-500")
	const yellow = useResolveClassNames("text-yellow-500")
	const red = useResolveClassNames("text-red-500")
	const blue = useResolveClassNames("text-blue-500")
	const muted = useResolveClassNames("text-muted-foreground")

	const { files, versioned, free, level } = computeStorageSegments(storageUsed, versionedStorage, maxStorage)
	const filesColor = (level === "critical" ? red.color : level === "warn" ? yellow.color : green.color) as string
	const versionedColor = blue.color as string
	const freeColor = muted.color as string

	return (
		<View className="bg-transparent gap-2">
			<View className="flex-row h-2 rounded-full overflow-hidden bg-background-tertiary">
				{files > 0 && <View style={{ flexGrow: files, flexBasis: 0, backgroundColor: filesColor }} />}
				{versioned > 0 && <View style={{ flexGrow: versioned, flexBasis: 0, backgroundColor: versionedColor }} />}
				{/* Transparent spacer — lets the track (bg-background-tertiary) show as "free". */}
				{free > 0 && <View style={{ flexGrow: free, flexBasis: 0 }} />}
			</View>
			<View className="flex-row flex-wrap gap-x-4 gap-y-1 bg-transparent">
				<LegendItem
					color={filesColor}
					text={`${t("files")} ${formatBytes(files)}`}
				/>
				<LegendItem
					color={versionedColor}
					text={`${t("versioned_files")} ${formatBytes(versioned)}`}
				/>
				<LegendItem
					color={freeColor}
					text={`${t("free")} ${formatBytes(free)}`}
				/>
			</View>
		</View>
	)
}

const LegendItem = ({ color, text }: { color: string; text: string }) => {
	return (
		<View className="flex-row items-center gap-1.5 bg-transparent">
			<View
				className="w-2.5 h-2.5 rounded-sm"
				style={{ backgroundColor: color }}
			/>
			<Text className="text-muted-foreground text-xs">{text}</Text>
		</View>
	)
}

export default StorageUsageBar
