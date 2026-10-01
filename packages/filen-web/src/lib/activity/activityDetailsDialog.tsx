import { useTranslation } from "react-i18next"
import { useActivityStore } from "@/lib/activity/activityStore"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

// Which items of a run failed and why, opened from its result toast's Details. Mounted once beside the
// toasts.
export function ActivityDetailsDialog() {
	const { t } = useTranslation("common")
	const details = useActivityStore(state => state.details)

	return (
		<Dialog
			open={details !== null}
			onOpenChange={open => {
				if (!open) {
					useActivityStore.setState({ details: null })
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{details?.title}</DialogTitle>
					<DialogDescription>{t("activityDetailsDescription")}</DialogDescription>
				</DialogHeader>
				<ul className="flex max-h-80 flex-col gap-2 overflow-y-auto text-sm">
					{details?.failures.map((failure, index) => (
						<li
							// Names can repeat across directories.
							key={index}
							className="flex flex-col"
						>
							<span className="truncate font-medium">{failure.name}</span>
							<span className="text-xs text-destructive">{errorLabel(failure.error)}</span>
						</li>
					))}
				</ul>
			</DialogContent>
		</Dialog>
	)
}
