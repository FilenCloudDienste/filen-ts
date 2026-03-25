import { Fragment, memo } from "react"
import View, { KeyboardStickyView, CrossGlassContainerView } from "@/components/ui/view"
import { useResolveClassNames } from "uniwind"
import { PressableOpacity } from "@/components/ui/pressables"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useKeyboardState } from "react-native-keyboard-controller"
import FontAwesome6 from "@expo/vector-icons/FontAwesome6"
import Menu, { type MenuButton } from "@/components/ui/menu"
import useRichtextStore from "@/stores/useRichtext.store"
import { useShallow } from "zustand/shallow"
import type { TextEditorEvents } from "@/components/textEditor"
import type { QuillFormats } from "@/components/textEditor/richText/dom"
import Text from "@/components/ui/text"
import prompts from "@/lib/prompts"
import * as Linking from "expo-linking"
import useTextEditorStore from "@/stores/useTextEditor.store"

const ICON_SIZE = 18

const Button = memo(
	({ type, postMessage }: { type: keyof QuillFormats | "keyboard"; postMessage: (message: TextEditorEvents) => void }) => {
		const formats = useRichtextStore(useShallow(state => state.formats))
		const textForeground = useResolveClassNames("text-foreground")
		const textPrimary = useResolveClassNames("text-primary")
		const keyboardState = useKeyboardState()

		const menuButtons = ((): MenuButton[] => {
			if (!keyboardState.isVisible) {
				return []
			}

			switch (type) {
				case "header": {
					return [
						{
							id: "header-1",
							title: "1",
							onPress: () => {
								postMessage({
									type: "quillToggleHeader",
									data: 1
								})
							}
						},
						{
							id: "header-2",
							title: "2",
							onPress: () => {
								postMessage({
									type: "quillToggleHeader",
									data: 2
								})
							}
						},
						{
							id: "header-3",
							title: "3",
							onPress: () => {
								postMessage({
									type: "quillToggleHeader",
									data: 3
								})
							}
						},
						{
							id: "header-4",
							title: "4",
							onPress: () => {
								postMessage({
									type: "quillToggleHeader",
									data: 4
								})
							}
						},
						{
							id: "header-5",
							title: "5",
							onPress: () => {
								postMessage({
									type: "quillToggleHeader",
									data: 5
								})
							}
						},
						{
							id: "header-6",
							title: "6",
							onPress: () => {
								postMessage({
									type: "quillToggleHeader",
									data: 6
								})
							}
						},
						{
							id: "header-normal",
							title: "normal",
							onPress: () => {
								postMessage({
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

										postMessage({
											type: "quillAddLink",
											data: response.value.trim().toLowerCase()
										})
									})
							}
						},
						{
							id: "remove",
							title: "tbd_remove",
							onPress: () => {
								if (type !== "link" || !formats.link) {
									return
								}

								postMessage({
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
							onPress: () => {
								postMessage({
									type: "quillToggleList",
									data: "ordered"
								})
							}
						},
						{
							id: "bullet",
							title: "tbd_bullet",
							onPress: () => {
								postMessage({
									type: "quillToggleList",
									data: "bullet"
								})
							}
						},
						{
							id: "checklist",
							title: "tbd_checklist",
							onPress: () => {
								postMessage({
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
										onPress: () => {
											postMessage({
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
					postMessage({
						type: "quillToggleBold"
					})

					break
				}

				case "italic": {
					postMessage({
						type: "quillToggleItalic"
					})

					break
				}

				case "underline": {
					postMessage({
						type: "quillToggleUnderline"
					})

					break
				}

				case "keyboard": {
					postMessage({
						type: "dismissKeyboard"
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

							postMessage({
								type: "quillAddLink",
								data: response.value.trim().toLowerCase()
							})
						})

					break
				}

				case "code-block": {
					postMessage({
						type: "quillToggleCodeBlock"
					})

					break
				}

				case "blockquote": {
					postMessage({
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
					className="flex-row items-center justify-center shrink-0 size-9"
					enabled={menuButtons.length === 0}
					onPress={onPress}
					hitSlop={5}
				>
					{type === "keyboard" ? (
						<FontAwesome6
							name="check"
							size={ICON_SIZE}
							color={textPrimary.color}
						/>
					) : type === "header" ? (
						<Fragment>
							<FontAwesome6
								name="heading"
								size={ICON_SIZE}
								color={formats[type] ? (textPrimary.color as string) : (textForeground.color as string)}
							/>
							{formats[type] && (
								<View className="flex-row items-center justify-center absolute rounded-full size-4 -mt-5 -mr-5 overflow-hidden bg-background-secondary border border-border">
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

const Toolbar = memo(({ postMessage }: { postMessage: (message: TextEditorEvents) => void }) => {
	const insets = useSafeAreaInsets()
	const keyboardState = useKeyboardState()
	const textEditorReady = useTextEditorStore(useShallow(state => state.ready))

	if (!textEditorReady) {
		return null
	}

	return (
		<KeyboardStickyView
			className="bg-transparent absolute left-0 right-0 bottom-0"
			offset={{
				opened: 0,
				closed: -(insets.bottom + 8)
			}}
		>
			{keyboardState.isVisible && (
				<View className="px-4 py-2 bg-transparent flex-row items-center justify-between gap-4">
					<CrossGlassContainerView className="shrink-0 flex-row items-center p-2 h-9">
						<Button
							type="header"
							postMessage={postMessage}
						/>
						<Button
							type="bold"
							postMessage={postMessage}
						/>
						<Button
							type="italic"
							postMessage={postMessage}
						/>
						<Button
							type="underline"
							postMessage={postMessage}
						/>
						<Button
							type="code-block"
							postMessage={postMessage}
						/>
						<Button
							type="link"
							postMessage={postMessage}
						/>
						<Button
							type="blockquote"
							postMessage={postMessage}
						/>
						<Button
							type="list"
							postMessage={postMessage}
						/>
					</CrossGlassContainerView>
					<CrossGlassContainerView className="shrink-0 size-9 flex-row items-center justify-center">
						<Button
							type="keyboard"
							postMessage={postMessage}
						/>
					</CrossGlassContainerView>
				</View>
			)}
		</KeyboardStickyView>
	)
})

export default Toolbar
