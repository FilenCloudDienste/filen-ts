import { useTranslation } from "react-i18next"
import { MinusIcon, PlusIcon } from "lucide-react"
import { usePhotosGridDensityQuery } from "@/features/photos/queries/preferences"
import { DENSITY_STEPS, DEFAULT_DENSITY_INDEX, clampDensityIndex, setPhotosGridDensity } from "@/features/photos/lib/gridDensity"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

// The grid's tile-size steps, shown in the Photos header; the grid reads the same stored density.
export function PhotosDensityControls() {
	const { t } = useTranslation("photos")
	const densityQuery = usePhotosGridDensityQuery()
	const densityIndex = densityQuery.data ?? DEFAULT_DENSITY_INDEX

	async function handleDensityChange(nextIndex: number): Promise<void> {
		await setPhotosGridDensity(clampDensityIndex(nextIndex))
		void densityQuery.refetch()
	}

	return (
		<div className="flex items-center gap-1">
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t("photosDensityDecrease")}
							disabled={densityIndex <= 0}
							onClick={() => {
								void handleDensityChange(densityIndex - 1)
							}}
						>
							<MinusIcon />
						</Button>
					}
				/>
				<TooltipContent>{t("photosDensityDecrease")}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t("photosDensityIncrease")}
							disabled={densityIndex >= DENSITY_STEPS.length - 1}
							onClick={() => {
								void handleDensityChange(densityIndex + 1)
							}}
						>
							<PlusIcon />
						</Button>
					}
				/>
				<TooltipContent>{t("photosDensityIncrease")}</TooltipContent>
			</Tooltip>
		</div>
	)
}
