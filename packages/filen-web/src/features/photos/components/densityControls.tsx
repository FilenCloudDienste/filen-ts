import { useTranslation } from "react-i18next"
import { MinusIcon, PlusIcon } from "lucide-react"
import { usePhotosGridDensityQuery } from "@/features/photos/queries/preferences"
import { DENSITY_STEPS, DEFAULT_DENSITY_INDEX, clampDensityIndex, setPhotosGridDensity } from "@/features/photos/lib/gridDensity"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import { Kbd } from "@/lib/keymap/kbd"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"

// The grid's tile-size steps, shown in the Photos header; the grid reads the same stored density.
export function PhotosDensityControls() {
	const { t } = useTranslation("photos")
	const densityQuery = usePhotosGridDensityQuery()
	const densityIndex = densityQuery.data ?? DEFAULT_DENSITY_INDEX
	const canDecrease = densityIndex > 0
	const canIncrease = densityIndex < DENSITY_STEPS.length - 1

	async function handleDensityChange(nextIndex: number): Promise<void> {
		await setPhotosGridDensity(clampDensityIndex(nextIndex))
		void densityQuery.refetch()
	}

	// The buttons' keys, mounted with them: only while the grid has photos to size.
	useAction(
		"photos.densityDecrease",
		() => {
			if (canDecrease) {
				void handleDensityChange(densityIndex - 1)
			}
		},
		OUTSIDE_OVERLAYS,
		[canDecrease, densityIndex]
	)

	useAction(
		"photos.densityIncrease",
		() => {
			if (canIncrease) {
				void handleDensityChange(densityIndex + 1)
			}
		},
		OUTSIDE_OVERLAYS,
		[canIncrease, densityIndex]
	)

	return (
		<div className="flex items-center gap-1">
			<TooltipIconButton
				label={t("photosDensityDecrease")}
				disabled={!canDecrease}
				shortcut={<Kbd action="photos.densityDecrease" />}
				onClick={() => {
					void handleDensityChange(densityIndex - 1)
				}}
			>
				<MinusIcon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t("photosDensityIncrease")}
				disabled={!canIncrease}
				shortcut={<Kbd action="photos.densityIncrease" />}
				onClick={() => {
					void handleDensityChange(densityIndex + 1)
				}}
			>
				<PlusIcon />
			</TooltipIconButton>
		</div>
	)
}
