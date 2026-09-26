import { useTranslation } from "react-i18next"
import { ArrowDownNarrowWideIcon } from "lucide-react"
import {
	DRIVE_SORT_FROM_PARTS,
	DRIVE_SORT_PARTS,
	type DriveSortBy,
	type DriveSortDirection,
	type DriveSortField
} from "@/features/drive/lib/sort"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

export interface SortMenuProps {
	value: DriveSortBy
	onChange: (next: DriveSortBy) => void
	// Recents is a fixed chronological view (@/features/drive/lib/preferences resolves it to
	// uploadDateDesc unconditionally) — the consuming shell passes true there so the trigger
	// renders inert instead of offering a choice that never takes effect.
	disabled?: boolean
}

export function SortMenu({ value, onChange, disabled = false }: SortMenuProps) {
	const { t } = useTranslation("drive")
	const { field, direction } = DRIVE_SORT_PARTS[value]

	const fields: { field: DriveSortField; label: string }[] = [
		{ field: "name", label: t("driveSortName") },
		{ field: "size", label: t("driveSortSize") },
		{ field: "type", label: t("driveSortType") },
		{ field: "uploadDate", label: t("driveSortUploadDate") },
		{ field: "lastModified", label: t("driveSortLastModified") }
	]

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="outline"
						size="sm"
						disabled={disabled}
					>
						<ArrowDownNarrowWideIcon />
						{t("driveSortBy")}
					</Button>
				}
			/>
			<DropdownMenuContent align="end">
				<DropdownMenuRadioGroup
					value={field}
					onValueChange={(next: DriveSortField) => {
						onChange(DRIVE_SORT_FROM_PARTS[next][direction])
					}}
				>
					{/* Base UI's Menu.GroupLabel reads its group context from the nearest Menu.Group/
					Menu.RadioGroup ancestor (mui/base-ui#4826) — it must nest inside the radio group it
					labels, not sit as a sibling before it (the Radix-shadcn convention this was ported
					from), or mounting throws "MenuGroupContext is missing". */}
					<DropdownMenuLabel>{t("driveSortBy")}</DropdownMenuLabel>
					{fields.map(row => (
						<DropdownMenuRadioItem
							key={row.field}
							value={row.field}
						>
							{row.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuRadioGroup
					value={direction}
					onValueChange={(next: DriveSortDirection) => {
						onChange(DRIVE_SORT_FROM_PARTS[field][next])
					}}
				>
					<DropdownMenuRadioItem value="asc">{t("driveSortAscending")}</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="desc">{t("driveSortDescending")}</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
