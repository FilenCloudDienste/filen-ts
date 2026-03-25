import { type NoteTag, NoteType } from "@filen/sdk-rs"
import { Menu as MenuComponent, type MenuButton } from "@/components/ui/menu"
import { memo } from "react"
import View from "@/components/ui/view"
import useNotesStore from "@/stores/useNotes.store"
import { useShallow } from "zustand/shallow"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import notes from "@/lib/notes"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { useRouter } from "expo-router"
import { Paths } from "expo-file-system"

export type TagMenuOrigin = "tags"

const Menu = memo(
	({
		children,
		origin,
		tag,
		...rest
	}: {
		children: React.ReactNode
		tag: NoteTag
		origin: TagMenuOrigin
	} & React.ComponentPropsWithoutRef<typeof MenuComponent>) => {
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
					title: "tbd_create_note",
					message: "tbd_enter_note_name",
					cancelText: "tbd_cancel",
					okText: "tbd_create"
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
				const n = await notes.create({
					title,
					content: "",
					type
				})

				await notes.addTag({
					note: n,
					tag
				})

				return n
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

			if (origin === "tags") {
				buttons.push({
					id: isSelected ? "deselect" : "select",
					title: isSelected ? "tbd_deselect" : "tbd_select",
					icon: "select",
					checked: isSelected,
					onPress: () => {
						useNotesStore.getState().setSelectedTags(prev => {
							if (isSelected) {
								return prev.filter(t => t.uuid !== tag.uuid)
							} else {
								return [...prev.filter(t => t.uuid !== tag.uuid), tag]
							}
						})
					}
				})
			}

			buttons.push({
				id: "create",
				title: "tbd_create_note",
				icon: "plus",
				subButtons: [
					{
						title: "tbd_text",
						id: "text",
						icon: "text",
						onPress: async () => {
							await createNote(NoteType.Text)
						}
					},
					{
						title: "tbd_checklist",
						id: "checklist",
						icon: "checklist",
						onPress: async () => {
							await createNote(NoteType.Checklist)
						}
					},
					{
						title: "tbd_markdown",
						id: "markdown",
						icon: "markdown",
						onPress: async () => {
							await createNote(NoteType.Md)
						}
					},
					{
						title: "tbd_code",
						id: "code",
						icon: "code",
						onPress: async () => {
							await createNote(NoteType.Code)
						}
					},
					{
						title: "tbd_richtext",
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
				title: tag.favorite ? "tbd_unfavorite" : "tbd_favorite",
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
				title: "tbd_rename",
				icon: "edit",
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.input({
							title: "tbd_rename_note",
							message: "tbd_enter_new_name",
							defaultValue: tag.name,
							cancelText: "tbd_cancel",
							okText: "tbd_rename"
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
				title: "tbd_delete",
				icon: "delete",
				destructive: true,
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: "tbd_delete_tag",
							message: "tbd_are_you_sure_delete_tag",
							cancelText: "tbd_cancel",
							okText: "tbd_delete"
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
)

export default Menu
