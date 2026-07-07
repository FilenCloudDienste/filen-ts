import { useTranslation } from "react-i18next"
import { ArrowDownNarrowWideIcon } from "lucide-react"
import { type DriveSortBy } from "@/lib/drive/sort"
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

type SortField = "name" | "size" | "type" | "uploadDate" | "lastModified"
type SortDirection = "asc" | "desc"

// Exhaustive lookup tables instead of string-splicing "nameAsc" -> {name, asc}: a field added to
// DriveSortBy without a matching entry here fails to compile (Record<DriveSortBy, …> / Record
// <SortField, Record<SortDirection, …>> both require every key).
const SORT_BY_PARTS: Record<DriveSortBy, { field: SortField; direction: SortDirection }> = {
	nameAsc: { field: "name", direction: "asc" },
	nameDesc: { field: "name", direction: "desc" },
	sizeAsc: { field: "size", direction: "asc" },
	sizeDesc: { field: "size", direction: "desc" },
	typeAsc: { field: "type", direction: "asc" },
	typeDesc: { field: "type", direction: "desc" },
	uploadDateAsc: { field: "uploadDate", direction: "asc" },
	uploadDateDesc: { field: "uploadDate", direction: "desc" },
	lastModifiedAsc: { field: "lastModified", direction: "asc" },
	lastModifiedDesc: { field: "lastModified", direction: "desc" }
}

const SORT_BY_FROM_PARTS: Record<SortField, Record<SortDirection, DriveSortBy>> = {
	name: { asc: "nameAsc", desc: "nameDesc" },
	size: { asc: "sizeAsc", desc: "sizeDesc" },
	type: { asc: "typeAsc", desc: "typeDesc" },
	uploadDate: { asc: "uploadDateAsc", desc: "uploadDateDesc" },
	lastModified: { asc: "lastModifiedAsc", desc: "lastModifiedDesc" }
}

export interface SortMenuProps {
	value: DriveSortBy
	onChange: (next: DriveSortBy) => void
	// Recents is a fixed chronological view (@/lib/drive/preferences resolves it to
	// uploadDateDesc unconditionally) — the consuming shell passes true there so the trigger
	// renders inert instead of offering a choice that never takes effect.
	disabled?: boolean
}

export function SortMenu({ value, onChange, disabled = false }: SortMenuProps) {
	const { t } = useTranslation("drive")
	const { field, direction } = SORT_BY_PARTS[value]

	const fields: { field: SortField; label: string }[] = [
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
					onValueChange={(next: SortField) => {
						onChange(SORT_BY_FROM_PARTS[next][direction])
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
					onValueChange={(next: SortDirection) => {
						onChange(SORT_BY_FROM_PARTS[field][next])
					}}
				>
					<DropdownMenuRadioItem value="asc">{t("driveSortAscending")}</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="desc">{t("driveSortDescending")}</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
