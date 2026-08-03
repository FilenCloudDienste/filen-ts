import { useTranslation } from "react-i18next"
import { LayoutGridIcon, ListIcon, SlidersHorizontalIcon } from "lucide-react"
import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

export interface ViewModeToggleProps {
	value: DriveViewMode
	onChange: (next: DriveViewMode) => void
	// Present only where the hide-hidden-items preference actually applies (hiddenFilterAppliesTo) —
	// offering it on trash/links/shared would promise a filter that never runs. One cohesive object so
	// the checkbox can never render half-wired. Phrased in SHOW terms to match the label; the stored
	// preference is the HIDE polarity (mobile parity), inverted by the caller.
	hiddenItems?: { show: boolean; onChange: (next: boolean) => void }
}

// The toolbar's "Display" control: list/grid presentation plus the hidden-items filter behind one
// bordered dropdown slot that can grow further display options later.
export function ViewModeToggle({ value, onChange, hiddenItems }: ViewModeToggleProps) {
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
				{/* Siblings of the radio group, never children of it: Base UI's GroupLabel/radio nesting rule
				(see the label above) applies inside that group only, and a checkbox item within it would
				inherit the wrong roving semantics. */}
				{hiddenItems ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuCheckboxItem
							checked={hiddenItems.show}
							onCheckedChange={hiddenItems.onChange}
						>
							{t("driveShowHiddenItems")}
						</DropdownMenuCheckboxItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
