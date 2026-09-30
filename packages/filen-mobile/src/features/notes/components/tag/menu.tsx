import { NoteType } from "@filen/sdk-rs"
import { type NoteTag } from "@/types"
import { Menu as MenuComponent, type MenuButton } from "@/components/ui/menu"
import View from "@/components/ui/view"
import useNotesStore from "@/features/notes/store/useNotes.store"
import { useShallow } from "zustand/shallow"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import notes from "@/features/notes/notes"
import { inputPrompt } from "@/lib/promptFlow"
import alerts from "@/lib/alerts"
import { router } from "@/lib/router"
import { Paths } from "expo-file-system"
import { useTranslation } from "react-i18next"
import logger from "@/lib/logger"
import { deleteTagAction } from "@/features/notes/components/notesActions"

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

	const createNote = async (type: NoteType) => {
		const title = await inputPrompt(
			{
				title: t("create_note"),
				message: t("enter_note_name"),
				cancelText: t("cancel"),
				okText: t("create")
			},
			{ tag: "notes", message: "create note in tag prompt failed", level: "error", context: { tagUuid: tag.uuid } },
			{ trim: true }
		)

		if (title === null) {
			return
		}

		const createResult = await runWithLoading(async () => {
			return await notes.createWithOptionalTag({
				title,
				type,
				tag
			})
		})

		if (!createResult.success) {
			logger.error("notes", "create note in tag failed", { error: createResult.error, tagUuid: tag.uuid })
			alerts.error(createResult.error)

			return
		}

		router.push(Paths.join("/", "note", createResult.data.uuid))
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
					useNotesStore.getState().setSelectedTags(prev => {
						if (isSelected) {
							return prev.filter(selectedTag => selectedTag.uuid !== tag.uuid)
						} else {
							return [...prev.filter(selectedTag => selectedTag.uuid !== tag.uuid), tag]
						}
					})
				}
			})
		}

		buttons.push({
			id: "create",
			title: t("create_note"),
			icon: "plus",
			requiresOnline: true,
			subButtons: [
				{
					title: t("note_type_text"),
					id: "text",
					icon: "text",
					requiresOnline: true,
					onPress: async () => {
						await createNote(NoteType.Text)
					}
				},
				{
					title: t("note_type_checklist"),
					id: "checklist",
					icon: "checklist",
					requiresOnline: true,
					onPress: async () => {
						await createNote(NoteType.Checklist)
					}
				},
				{
					title: t("note_type_code"),
					id: "code",
					icon: "code",
					requiresOnline: true,
					onPress: async () => {
						await createNote(NoteType.Code)
					}
				},
				{
					title: t("note_type_richtext"),
					id: "richtext",
					icon: "richtext",
					requiresOnline: true,
					onPress: async () => {
						await createNote(NoteType.Rich)
					}
				},
				{
					title: t("note_type_markdown"),
					id: "markdown",
					icon: "markdown",
					requiresOnline: true,
					onPress: async () => {
						await createNote(NoteType.Md)
					}
				}
			]
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
