import Text from "@/components/ui/text"
import { router } from "@/lib/router"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import ListRow from "@/components/ui/listRow"
import useOfflineStore from "@/features/offline/store/useOffline.store"
import { useTranslation } from "react-i18next"

// Pressable list-header row shown at the offline VIRTUAL ROOT only — Drive injects it via the
// VirtualList headerComponent slot when drivePath is the offline root. Hidden while the last
// completed sync pass produced no errors; tapping it opens the offlineSyncErrors modal.
const SyncErrorsHeaderRow = () => {
	const { t } = useTranslation()
	const syncErrorCount = useOfflineStore(state => state.syncErrors.length)
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	if (syncErrorCount === 0) {
		return null
	}

	return (
		<ListRow
			separator={true}
			density="relaxed"
			onPress={() => {
				router.push("/offlineSyncErrors")
			}}
			title={
				<Text
					className="text-red-500"
					numberOfLines={1}
				>
					{t("offline_sync_errors_count", {
						count: syncErrorCount
					})}
				</Text>
			}
			trailing={
				<Ionicons
					className="shrink-0"
					name="chevron-forward-outline"
					size={18}
					color={textMutedForeground.color}
				/>
			}
		/>
	)
}

export default SyncErrorsHeaderRow
