import { useTranslation } from "react-i18next"
import { LayoutGridIcon, ListIcon, SlidersHorizontalIcon } from "lucide-react"
import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

export interface ViewModeToggleProps {
	value: DriveViewMode
	onChange: (next: DriveViewMode) => void
}

// The toolbar's "Display" control: list/grid presentation behind one bordered dropdown slot that can
// grow further display options later (replaces the earlier two-button pressed toggle).
export function ViewModeToggle({ value, onChange }: ViewModeToggleProps) {
	const { t } = useTranslation("drive")

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="outline"
						size="sm"
					>
						<SlidersHorizontalIcon />
						{t("driveDisplay")}
					</Button>
				}
			/>
			<DropdownMenuContent align="start">
				<DropdownMenuRadioGroup
					value={value}
					onValueChange={(next: DriveViewMode) => {
						onChange(next)
					}}
				>
					{/* Base UI's Menu.GroupLabel must nest inside the radio group it labels (see sortMenu.tsx). */}
					<DropdownMenuLabel>{t("driveDisplay")}</DropdownMenuLabel>
					<DropdownMenuRadioItem value="list">
						<ListIcon />
						{t("driveViewList")}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="grid">
						<LayoutGridIcon />
						{t("driveViewGrid")}
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
