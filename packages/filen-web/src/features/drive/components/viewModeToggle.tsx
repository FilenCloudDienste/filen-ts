import { useTranslation } from "react-i18next"
import { LayoutGridIcon, ListIcon } from "lucide-react"
import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export interface ViewModeToggleProps {
	value: DriveViewMode
	onChange: (next: DriveViewMode) => void
}

// A 2-way toggle button pair (WAI-ARIA "button" pattern with aria-pressed), not a radiogroup —
// each button already carries its own accessible name, so no wrapping group label is needed.
export function ViewModeToggle({ value, onChange }: ViewModeToggleProps) {
	const { t } = useTranslation("drive")

	return (
		<div className="inline-flex items-center gap-0.5 p-0.5">
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant={value === "list" ? "secondary" : "ghost"}
							size="icon-sm"
							aria-pressed={value === "list"}
							aria-label={t("driveViewList")}
							onClick={() => {
								onChange("list")
							}}
						>
							<ListIcon />
						</Button>
					}
				/>
				<TooltipContent>{t("driveViewList")}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant={value === "grid" ? "secondary" : "ghost"}
							size="icon-sm"
							aria-pressed={value === "grid"}
							aria-label={t("driveViewGrid")}
							onClick={() => {
								onChange("grid")
							}}
						>
							<LayoutGridIcon />
						</Button>
					}
				/>
				<TooltipContent>{t("driveViewGrid")}</TooltipContent>
			</Tooltip>
		</div>
	)
}
