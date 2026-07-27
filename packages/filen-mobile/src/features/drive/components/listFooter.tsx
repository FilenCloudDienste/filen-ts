import { useTranslation } from "react-i18next"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { type DriveSearchStatus } from "@/features/drive/hooks/useDriveSearch"
import { shouldShowSearchTruncationNotice } from "@/features/drive/hooks/driveSearchStatus"

/**
 * Bottom-of-list footer for every drive listing. Carries the two notices that explain why the rows
 * above are not the whole story:
 *
 *  - the cache search loaded only the alphabetically-first slice of a larger match set, so the list
 *    is capped and refining the term will help;
 *  - the hidden-items preference is withholding rows.
 *
 * Both are suppressed on an empty list. FlashList renders a footer ALONGSIDE its empty component
 * (only the empty one is data-length gated), so without this a fully-filtered list would caption
 * itself "showing the first 0 of N" underneath an empty state that just said something else. The
 * all-hidden case carries its explanation in that empty state instead.
 *
 * The "still searching" signal lives in the header (always visible) and offline is covered by the
 * global offline banner — one signal, one place. Renders nothing in every other state.
 */
const DriveListFooter = ({
	status,
	totalCount,
	loadedCount,
	renderedCount,
	hiddenCount,
	setting,
	settingPath
}: {
	status: DriveSearchStatus
	// Search only; inert when the listing is not the cache search.
	totalCount: number
	// How many hits the SDK window delivered. Truncation is a property of the WINDOW, so this — not
	// `resultCount` — decides whether the notice applies: a local display filter shrinks what is
	// rendered without anything having been left unloaded.
	loadedCount: number
	// How many rows are actually on screen, after any local filtering. Gates the whole footer —
	// never used as the truncation caption's number, which is about the WINDOW (see loadedCount).
	renderedCount: number
	// How many rows the hidden-items preference withheld from this listing.
	hiddenCount: number
	// The preference's own label and where it lives, already localized by the caller. The
	// partial-hide line is the notice most users will actually see, so it names both the switch and
	// the screen — "turn this off" has no antecedent once the sentence is read on its own.
	setting: string
	settingPath: string
}) => {
	const { t } = useTranslation()

	if (renderedCount === 0) {
		return null
	}

	const truncated = shouldShowSearchTruncationNotice({ status, totalCount, loadedCount })

	if (!truncated && hiddenCount === 0) {
		return null
	}

	return (
		<View className="bg-transparent px-4 py-3 gap-1">
			{truncated && (
				<Text
					className="text-muted-foreground text-center text-sm"
					numberOfLines={2}
				>
					{t("search_results_truncated", {
						shown: loadedCount,
						total: totalCount
					})}
				</Text>
			)}
			{hiddenCount > 0 && (
				<Text
					className="text-muted-foreground text-center text-sm"
					numberOfLines={2}
				>
					{t("hidden_items_not_shown", {
						count: hiddenCount,
						setting,
						path: settingPath
					})}
				</Text>
			)}
		</View>
	)
}

export default DriveListFooter
