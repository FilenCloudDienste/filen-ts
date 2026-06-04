import { NoteType } from "@filen/sdk-rs"
import { type NoteTag } from "@/types"
import { Menu as MenuComponent, type MenuButton } from "@/components/ui/menu"
import View from "@/components/ui/view"
import useNotesStore from "@/features/notes/store/useNotes.store"
import { useShallow } from "zustand/shallow"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import notes from "@/features/notes/notes"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { useRouter } from "expo-router"
import { Paths } from "expo-file-system"
import { useTranslation } from "react-i18next"

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
	const router = useRouter()

	const onOpenMenu = () => {
		useNotesStore.getState().setActiveTag(tag)
	}

	const onCloseMenu = () => {
		useNotesStore.getState().setActiveTag(null)
	}

	const createNote = async (type: NoteType) => {
		const result = await run(async () => {
			return await prompts.input({
				title: t("create_note"),
				message: t("enter_note_name"),
				cancelText: t("cancel"),
				okText: t("create")
			})
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)

			return
		}

		if (result.data.cancelled || result.data.type !== "string") {
			return
		}

		const title = result.data.value.trim()

		if (title.length === 0) {
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
			console.error(createResult.error)
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

		if (tag.undecryptable) {
			buttons.push({
				id: "delete",
				title: t("delete"),
				icon: "delete",
				destructive: true,
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: t("delete_tag"),
							message: t("are_you_sure_delete_tag"),
							cancelText: t("cancel"),
							okText: t("delete"),
							destructive: true
						})
					})

					if (!promptResult.success) {
						console.error(promptResult.error)
						alerts.error(promptResult.error)

						return
					}

					if (promptResult.data.cancelled) {
						return
					}

					const result = await runWithLoading(async () => {
						await notes.deleteTag({
							tag
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}
				}
			})

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
			subButtons: [
				{
					title: t("note_type_text"),
					id: "text",
					icon: "text",
					onPress: async () => {
						await createNote(NoteType.Text)
					}
				},
				{
					title: t("note_type_checklist"),
					id: "checklist",
					icon: "checklist",
					onPress: async () => {
						await createNote(NoteType.Checklist)
					}
				},
				{
					title: t("note_type_markdown"),
					id: "markdown",
					icon: "markdown",
					onPress: async () => {
						await createNote(NoteType.Md)
					}
				},
				{
					title: t("note_type_code"),
					id: "code",
					icon: "code",
					onPress: async () => {
						await createNote(NoteType.Code)
					}
				},
				{
					title: t("note_type_richtext"),
					id: "richtext",
					icon: "richtext",
					onPress: async () => {
						await createNote(NoteType.Rich)
					}
				}
			]
		})

		buttons.push({
			id: tag.favorite ? "unfavorite" : "favorite",
			title: tag.favorite ? t("unfavorite") : t("favorite"),
			icon: "heart",
			onPress: async () => {
				const result = await runWithLoading(async () => {
					await notes.favoriteTag({
						tag,
						favorite: !tag.favorite
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		})

		buttons.push({
			id: "rename",
			title: t("rename"),
			icon: "edit",
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.input({
						title: t("rename_tag"),
						message: t("enter_new_name"),
						defaultValue: tag.name,
						cancelText: t("cancel"),
						okText: t("rename")
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled || promptResult.data.type !== "string") {
					return
				}

				const newName = promptResult.data.value.trim()

				if (newName.length === 0) {
					return
				}

				const result = await runWithLoading(async () => {
					await notes.renameTag({
						tag,
						newName
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		})

		buttons.push({
			id: "delete",
			title: t("delete"),
			icon: "delete",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("delete_tag"),
						message: t("are_you_sure_delete_tag"),
						cancelText: t("cancel"),
						okText: t("delete"),
						destructive: true
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				const result = await runWithLoading(async () => {
					await notes.deleteTag({
						tag
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		})

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
