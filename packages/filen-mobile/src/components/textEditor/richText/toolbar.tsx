import { Fragment, memo } from "react"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { useResolveClassNames } from "uniwind"
import { PressableOpacity } from "@/components/ui/pressables"
import FontAwesome6 from "@expo/vector-icons/FontAwesome6"
import Menu, { type MenuButton } from "@/components/ui/menu"
import useRichtextStore from "@/stores/useRichtext.store"
import { useShallow } from "zustand/shallow"
import type { TextEditorEvents } from "@/components/textEditor"
import type { QuillFormats } from "@/components/textEditor/richText/dom"
import Text from "@/components/ui/text"
import prompts from "@/lib/prompts"
import * as Linking from "expo-linking"

// Compact sizing tuned for the native stack header bar (~44pt iOS / ~56dp
// Android). Slightly smaller than the old floating toolbar so all 9 buttons
// fit inside the title slot's horizontal budget on common phone widths; a
// ScrollView absorbs the rest on narrow devices.
const ICON_SIZE = 16
const BUTTON_CLASS = "flex-row items-center justify-center shrink-0 size-8"

const Button = memo(
	({
		type,
		dispatch
	}: {
		type: keyof QuillFormats
		dispatch: (event: TextEditorEvents) => void
	}) => {
		const formats = useRichtextStore(useShallow(state => state.formats))
		const textForeground = useResolveClassNames("text-foreground")
		const textPrimary = useResolveClassNames("text-primary")

		const menuButtons = ((): MenuButton[] => {
			switch (type) {
				case "header": {
					return [
						{
							id: "header-1",
							title: "1",
							icon: "headerH" as const,
							onPress: () => {
								dispatch({
									type: "quillToggleHeader",
									data: 1
								})
							}
						},
						{
							id: "header-2",
							title: "2",
							icon: "headerH" as const,
							onPress: () => {
								dispatch({
									type: "quillToggleHeader",
									data: 2
								})
							}
						},
						{
							id: "header-3",
							title: "3",
							icon: "headerH" as const,
							onPress: () => {
								dispatch({
									type: "quillToggleHeader",
									data: 3
								})
							}
						},
						{
							id: "header-4",
							title: "4",
							icon: "headerH" as const,
							onPress: () => {
								dispatch({
									type: "quillToggleHeader",
									data: 4
								})
							}
						},
						{
							id: "header-5",
							title: "5",
							icon: "headerH" as const,
							onPress: () => {
								dispatch({
									type: "quillToggleHeader",
									data: 5
								})
							}
						},
						{
							id: "header-6",
							title: "6",
							icon: "headerH" as const,
							onPress: () => {
								dispatch({
									type: "quillToggleHeader",
									data: 6
								})
							}
						},
						{
							id: "header-normal",
							title: "normal",
							icon: "text" as const,
							onPress: () => {
								dispatch({
									type: "quillRemoveHeader"
								})
							}
						}
					]
				}

				case "link": {
					if (!formats.link) {
						return []
					}

					return [
						{
							id: "open",
							title: "tbd_open",
							icon: "openExternal" as const,
							onPress: () => {
								if (type !== "link" || !formats.link) {
									return
								}

								Linking.openURL(formats.link).catch(console.error)
							}
						},
						{
							id: "edit",
							title: "tbd_edit",
							icon: "edit" as const,
							onPress: () => {
								if (type !== "link" || !formats.link) {
									return
								}

								prompts
									.input({
										title: "tbd",
										message: "tbd",
										placeholder: "tbd",
										defaultValue: formats.link,
										okText: "tbd",
										cancelText: "tbd"
									})
									.then(response => {
										if (response.cancelled || response.type !== "string" || !response.value.trim()) {
											return
										}

										dispatch({
											type: "quillAddLink",
											data: response.value.trim().toLowerCase()
										})
									})
							}
						},
						{
							id: "remove",
							title: "tbd_remove",
							icon: "minus" as const,
							onPress: () => {
								if (type !== "link" || !formats.link) {
									return
								}

								dispatch({
									type: "quillRemoveLink"
								})
							}
						}
					]
				}

				case "list": {
					return [
						{
							id: "ordered",
							title: "tbd_ordered",
							icon: "listOrdered" as const,
							onPress: () => {
								dispatch({
									type: "quillToggleList",
									data: "ordered"
								})
							}
						},
						{
							id: "bullet",
							title: "tbd_bullet",
							icon: "listBullet" as const,
							onPress: () => {
								dispatch({
									type: "quillToggleList",
									data: "bullet"
								})
							}
						},
						{
							id: "checklist",
							title: "tbd_checklist",
							icon: "checklist" as const,
							onPress: () => {
								dispatch({
									type: "quillToggleList",
									data: "checklist"
								})
							}
						},
						...(formats.list
							? [
									{
										id: "remove",
										title: "tbd_remove",
										icon: "minus" as const,
										onPress: () => {
											dispatch({
												type: "quillRemoveList"
											})
										}
									}
								]
							: [])
					]
				}

				default: {
					return []
				}
			}
		})()

		const onPress = () => {
			switch (type) {
				case "bold": {
					dispatch({
						type: "quillToggleBold"
					})

					break
				}

				case "italic": {
					dispatch({
						type: "quillToggleItalic"
					})

					break
				}

				case "underline": {
					dispatch({
						type: "quillToggleUnderline"
					})

					break
				}

				case "link": {
					if (formats.link) {
						break
					}

					prompts
						.input({
							title: "tbd",
							message: "tbd",
							placeholder: "tbd",
							okText: "tbd",
							cancelText: "tbd"
						})
						.then(response => {
							if (response.cancelled || response.type !== "string" || !response.value.trim()) {
								return
							}

							dispatch({
								type: "quillAddLink",
								data: response.value.trim().toLowerCase()
							})
						})

					break
				}

				case "code-block": {
					dispatch({
						type: "quillToggleCodeBlock"
					})

					break
				}

				case "blockquote": {
					dispatch({
						type: "quillToggleBlockquote"
					})

					break
				}
			}
		}

		return (
			<Menu
				type="dropdown"
				disabled={menuButtons.length === 0}
				buttons={menuButtons}
			>
				<PressableOpacity
					rippleColor="transparent"
					className={BUTTON_CLASS}
					enabled={menuButtons.length === 0}
					onPress={onPress}
					hitSlop={5}
				>
					{type === "header" ? (
						<Fragment>
							<FontAwesome6
								name="heading"
								size={ICON_SIZE}
								color={formats[type] ? (textPrimary.color as string) : (textForeground.color as string)}
							/>
							{formats[type] && (
								<View className="flex-row items-center justify-center absolute rounded-full size-4 -mt-4 -mr-4 overflow-hidden bg-background-secondary border border-border">
									<Text className="text-foreground text-xs">{formats[type]}</Text>
								</View>
							)}
						</Fragment>
					) : type === "list" ? (
						<FontAwesome6
							name={
								formats[type] === "ordered"
									? "list-ol"
									: formats[type] === "bullet"
										? "list-ul"
										: formats[type] === "checked" || formats[type] === "unchecked"
											? "list-check"
											: "list"
							}
							size={ICON_SIZE}
							color={formats[type] ? (textPrimary.color as string) : (textForeground.color as string)}
						/>
					) : (
						<FontAwesome6
							name={
								type === "bold"
									? "bold"
									: type === "italic"
										? "italic"
										: type === "underline"
											? "underline"
											: type === "link"
												? "link"
												: type === "code-block"
													? "code"
													: type === "blockquote"
														? "quote-right"
														: "question"
							}
							size={ICON_SIZE}
							color={formats[type] ? (textPrimary.color as string) : (textForeground.color as string)}
						/>
					)}
				</PressableOpacity>
			</Menu>
		)
	}
)

// Compact horizontal strip rendered inside the navigation header's title slot
// while the user is typing in a rich-text note. Scrolls horizontally as a
// safety net on narrow phones — the natural width (~250pt) fits inside the
// iOS title slot (~300pt usable) on every modern iPhone without scrolling.
export const RichTextHeaderToolbar = memo(({ dispatch }: { dispatch: (event: TextEditorEvents) => void }) => {
	return (
		<GestureHandlerScrollView
			horizontal={true}
			showsHorizontalScrollIndicator={false}
			contentContainerClassName="flex-row items-center"
		>
			<Button
				type="header"
				dispatch={dispatch}
			/>
			<Button
				type="bold"
				dispatch={dispatch}
			/>
			<Button
				type="italic"
				dispatch={dispatch}
			/>
			<Button
				type="underline"
				dispatch={dispatch}
			/>
			<Button
				type="code-block"
				dispatch={dispatch}
			/>
			<Button
				type="link"
				dispatch={dispatch}
			/>
			<Button
				type="blockquote"
				dispatch={dispatch}
			/>
			<Button
				type="list"
				dispatch={dispatch}
			/>
		</GestureHandlerScrollView>
	)
})

export default RichTextHeaderToolbar
