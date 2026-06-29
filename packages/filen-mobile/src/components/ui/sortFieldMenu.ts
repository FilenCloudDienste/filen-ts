import { Platform } from "react-native"
import { type TFunction } from "i18next"
import { type MenuButton } from "@/components/ui/menu"
import { type Icons } from "@/components/ui/menuIcons"
import { actionSheet } from "@/providers/actionSheet.provider"

// One selectable sort direction for a field (e.g. Name → Ascending / Descending). `value` is the
// concrete sort key handed back to setSort; `id` is the menu-item id used on the nested-menu path.
export type SortDirectionOption<T extends string> = {
	id: string
	title: string
	value: T
}

// Builds a single sort "field" menu button (Name / Size / Last activity / …) whose directions
// (asc/desc, newest/oldest, …) live one level deeper.
//
// WHY THIS EXISTS: @react-native-menu/menu does NOT support a submenu nested inside a submenu on
// Android ("On Android it does not support nesting next sub menus in sub menu item" — its own docs).
// A field → direction submenu sits at the 3rd level of the header sort dropdown, so the directions
// are unreachable on Android. The shared Menu primitive (components/ui/menu) stays untouched; the
// platform split lives here so every sort menu (drive, notes tags, …) gets the same treatment by
// calling this builder.
//
//   iOS / non-Android: keep the nested submenu of direction leaves, each checkmarked when active.
//   Android:           collapse to a single leaf (the field), checkmarked when the active sort is
//                      one of its directions, whose press opens an ActionSheet to pick the direction.
export function buildSortFieldButton<T extends string>({
	id,
	title,
	icon,
	options,
	current,
	setSort,
	t
}: {
	id: string
	title: string
	icon?: Icons
	options: SortDirectionOption<T>[]
	current: T
	setSort: (next: T) => void
	t: TFunction
}): MenuButton {
	if (Platform.OS !== "android") {
		// Leaf objects MUST NOT carry a `subButtons` key — the iOS rendering path uses
		// `"subButtons" in button` to tell a leaf from a submenu (see components/ui/menu).
		return {
			id,
			title,
			icon,
			subButtons: options.map(option => ({
				id: option.id,
				title: option.title,
				checked: current === option.value,
				onPress: () => setSort(option.value)
			}))
		}
	}

	return {
		id,
		title,
		icon,
		checked: options.some(option => option.value === current),
		onPress: () =>
			actionSheet.show({
				title,
				buttons: [
					...options.map(option => ({
						title: option.value === current ? `${option.title} (${t("current")})` : option.title,
						onPress: () => setSort(option.value)
					})),
					{
						title: t("cancel"),
						cancel: true
					}
				]
			})
	}
}
