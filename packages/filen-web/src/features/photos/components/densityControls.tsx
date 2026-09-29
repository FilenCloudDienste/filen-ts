import { useTranslation } from "react-i18next"
import { MinusIcon, PlusIcon } from "lucide-react"
import { usePhotosGridDensityQuery } from "@/features/photos/queries/preferences"
import { DENSITY_STEPS, DEFAULT_DENSITY_INDEX, clampDensityIndex, setPhotosGridDensity } from "@/features/photos/lib/gridDensity"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"

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
			<TooltipIconButton
				label={t("photosDensityDecrease")}
				disabled={densityIndex <= 0}
				onClick={() => {
					void handleDensityChange(densityIndex - 1)
				}}
			>
				<MinusIcon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t("photosDensityIncrease")}
				disabled={densityIndex >= DENSITY_STEPS.length - 1}
				onClick={() => {
					void handleDensityChange(densityIndex + 1)
				}}
			>
				<PlusIcon />
			</TooltipIconButton>
		</div>
	)
}
