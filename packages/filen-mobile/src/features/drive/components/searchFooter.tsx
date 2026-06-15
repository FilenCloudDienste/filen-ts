import { useTranslation } from "react-i18next"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { type DriveSearchStatus } from "@/features/drive/hooks/useDriveSearch"

/**
 * Bottom-of-list footer for the cache-backed drive search. Shows ONLY the truncation
 * notice: the match count exceeds the loaded window CEILING, so the list is the
 * alphabetically-first slice — nudge the user to refine. The "still searching" signal
 * lives in the header (always visible) and offline is covered by the global offline
 * banner — one signal, one place. Returns null in every other state.
 */
const DriveSearchFooter = ({
	status,
	totalCount,
	resultCount
}: {
	status: DriveSearchStatus
	totalCount: number
	resultCount: number
}) => {
	const { t } = useTranslation()

	if (status === "settled" && totalCount > resultCount) {
		return (
			<View className="bg-transparent px-4 py-3">
				<Text
					className="text-muted-foreground text-center text-sm"
					numberOfLines={2}
				>
					{t("search_results_truncated", {
						shown: resultCount,
						total: totalCount
					})}
				</Text>
			</View>
		)
	}

	return null
}

export default DriveSearchFooter
