import { type TFunction } from "i18next"
import { type MenuButton } from "@/components/ui/menu"

// The select-all / deselect-all toggle. Callers own the "all selected" predicate and any guards.
export function selectAllMenuButton(params: {
	t: TFunction
	allSelected: boolean
	onClear: () => void
	onSelectAll: () => void
	id?: string
}): MenuButton {
	return {
		id: params.id ?? "selectAll",
		title: params.allSelected ? params.t("deselect_all") : params.t("select_all"),
		icon: "select",
		onPress: params.allSelected ? params.onClear : params.onSelectAll
	}
}
