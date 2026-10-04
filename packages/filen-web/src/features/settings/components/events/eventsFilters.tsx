import { useTranslation } from "react-i18next"
import { EVENT_CATEGORIES } from "@/features/settings/lib/eventModel"
import type { EventsCategoryFilter, EventsFilter } from "@/features/settings/components/events/eventsList.logic"
import type { EventsKey } from "@/lib/i18n"
import { ListFilterInput } from "@/components/listFilterInput"
import { Button } from "@/components/ui/button"

const CATEGORY_LABEL = {
	all: "eventsCategoryAll",
	files: "eventsCategoryFiles",
	directories: "eventsCategoryDirectories",
	sharing: "eventsCategorySharing",
	security: "eventsCategorySecurity",
	account: "eventsCategoryAccount"
} as const satisfies Record<EventsCategoryFilter, EventsKey>

const CATEGORY_FILTERS = ["all", ...EVENT_CATEGORIES] as const satisfies readonly EventsCategoryFilter[]

// Category chips and the search box, both over the loaded events only.
export function EventsFilters({ filter, onChange }: { filter: EventsFilter; onChange: (filter: EventsFilter) => void }) {
	const { t } = useTranslation("events")

	return (
		<div className="flex shrink-0 flex-col gap-2">
			<ListFilterInput
				value={filter.query}
				onChange={query => {
					onChange({ ...filter, query })
				}}
				placeholder={t("eventsSearchPlaceholder")}
				ariaLabel={t("eventsSearchPlaceholder")}
			/>
			<div
				role="group"
				aria-label={t("eventsCategoryFilterLabel")}
				className="flex flex-wrap items-center gap-1"
			>
				{CATEGORY_FILTERS.map(category => (
					<Button
						key={category}
						variant={filter.category === category ? "secondary" : "outline"}
						size="xs"
						className="rounded-full"
						aria-pressed={filter.category === category}
						onClick={() => {
							onChange({ ...filter, category })
						}}
					>
						{t(CATEGORY_LABEL[category])}
					</Button>
				))}
			</div>
		</div>
	)
}
