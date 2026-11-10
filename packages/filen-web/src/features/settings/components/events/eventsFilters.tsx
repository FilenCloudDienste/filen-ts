import { useRef } from "react"
import { useTranslation } from "react-i18next"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
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
	const rootRef = useRef<HTMLDivElement>(null)

	// Def in features/settings/lib/keymap.ts: Mod+F searches the events, in place of the browser's find; the page
	// under a dialog or menu stands down.
	useAction(
		"settings.search",
		event => {
			const input = rootRef.current?.querySelector("input")

			if (input) {
				event.preventDefault()
				input.focus()
				input.select()
			}
		},
		OUTSIDE_OVERLAYS
	)

	return (
		<div
			ref={rootRef}
			className="flex shrink-0 flex-col gap-2"
		>
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
