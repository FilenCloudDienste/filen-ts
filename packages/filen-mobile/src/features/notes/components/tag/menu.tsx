import { type NoteTag } from "@/types"
import { Menu as MenuComponent, type MenuButton } from "@/components/ui/menu"
import View from "@/components/ui/view"
import useNotesStore from "@/features/notes/store/useNotes.store"
import { useShallow } from "zustand/shallow"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import notes from "@/features/notes/notes"
import { inputPrompt } from "@/lib/promptFlow"
import alerts from "@/lib/alerts"
import { useTranslation } from "react-i18next"
import logger from "@/lib/logger"
import { createNoteSubButtons } from "@/features/notes/components/note/menu"
import { createNoteFlow, deleteTagAction } from "@/features/notes/components/notesActions"

export type TagMenuOrigin = "tags"

const Menu = ({
	children,
	origin,
	tag,
	...rest
}: {
	children: React.ReactNode
	tag: NoteTag
	origin: TagMenuOrigin
} & React.ComponentPropsWithoutRef<typeof MenuComponent>) => {
	const { t } = useTranslation()
	const isSelected = useNotesStore(useShallow(state => state.selectedTags.some(selectedTag => selectedTag.uuid === tag.uuid)))

	const onOpenMenu = () => {
		useNotesStore.getState().setActiveTag(tag)
	}

	const onCloseMenu = () => {
		useNotesStore.getState().setActiveTag(null)
	}

	const buttons = (() => {
		if (rest.disabled) {
			return []
		}

		const buttons: MenuButton[] = []

		const deleteButton: MenuButton = {
			id: "delete",
			title: t("delete"),
			icon: "delete",
			destructive: true,
			requiresOnline: true,
			onPress: deleteTagAction({ t, tag })
		}

		if (tag.undecryptable) {
			buttons.push(deleteButton)

			return buttons
		}

		if (origin === "tags") {
			buttons.push({
				id: isSelected ? "deselect" : "select",
				title: isSelected ? t("deselect") : t("select"),
				icon: "select",
				checked: isSelected,
				onPress: () => {
					useNotesStore.getState().toggleSelectedTag(tag)
				}
			})
		}

		buttons.push({
			id: "create",
			title: t("create_note"),
			icon: "plus",
			requiresOnline: true,
			subButtons: createNoteSubButtons(t, type => createNoteFlow({ t, tag, type }))
		})

		buttons.push({
			id: tag.favorite ? "unfavorite" : "favorite",
			title: tag.favorite ? t("unfavorite") : t("favorite"),
			icon: "heart",
			requiresOnline: true,
			onPress: async () => {
				const result = await runWithLoading(async () => {
					await notes.favoriteTag({
						tag,
						favorite: !tag.favorite
					})
				})

				if (!result.success) {
					logger.error("notes", "set tag favorited failed", { error: result.error, tagUuid: tag.uuid })
					alerts.error(result.error)

					return
				}
			}
		})

		buttons.push({
			id: "rename",
			title: t("rename"),
			icon: "edit",
			requiresOnline: true,
			onPress: async () => {
				const newName = await inputPrompt(
					{
						title: t("rename_tag"),
						message: t("enter_new_name"),
						defaultValue: tag.name,
						cancelText: t("cancel"),
						okText: t("rename")
					},
					{ tag: "notes", message: "rename tag prompt failed", level: "error", context: { tagUuid: tag.uuid } },
					{ trim: true }
				)

				if (newName === null) {
					return
				}

				const result = await runWithLoading(async () => {
					await notes.renameTag({
						tag,
						newName
					})
				})

				if (!result.success) {
					logger.error("notes", "rename tag failed", { error: result.error, tagUuid: tag.uuid })
					alerts.error(result.error)

					return
				}
			}
		})

		buttons.push(deleteButton)

		return buttons
	})()

	if (buttons.length === 0 || rest.disabled) {
		return <View className={rest.className}>{children}</View>
	}

	return (
		<MenuComponent
			buttons={buttons}
			onOpenMenu={onOpenMenu}
			onCloseMenu={onCloseMenu}
			{...rest}
		>
			{children}
		</MenuComponent>
	)
}

export default Menu
