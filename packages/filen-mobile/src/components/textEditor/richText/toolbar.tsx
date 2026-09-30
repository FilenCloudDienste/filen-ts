import type { ComponentProps } from "react"
import { useTranslation } from "react-i18next"
import View, { GestureHandlerScrollView, CrossGlassContainerView } from "@/components/ui/view"
import { useResolveClassNames } from "uniwind"
import { PressableOpacity } from "@/components/ui/pressables"
import FontAwesome6 from "@expo/vector-icons/FontAwesome6"
import Menu, { type MenuButton } from "@/components/ui/menu"
import useRichtextStore from "@/stores/useRichtext.store"
import type { TextEditorEvents } from "@/components/textEditor"
import type { QuillFormats, HeaderLevel } from "@/components/textEditor/richText/dom"
import { classifyExternalLinkHref } from "@/components/textEditor/linkUtils"
import Text from "@/components/ui/text"
import prompts from "@/lib/prompts"
import { cn } from "@filen/shared"
import { Platform } from "react-native"
import logger from "@/lib/logger"
import useOpenExternalLink from "@/hooks/useOpenExternalLink"

// Compact sizing tuned for the native stack header bar (~44pt iOS / ~56dp
// Android). Slightly smaller than the old floating toolbar so all 9 buttons
// fit inside the title slot's horizontal budget on common phone widths; a
// ScrollView absorbs the rest on narrow devices.
const ICON_SIZE = 16
const BUTTON_CLASS = "flex-row items-center justify-center shrink-0 size-8"

type IconName = ComponentProps<typeof FontAwesome6>["name"]

type ToggleEventType = Extract<
	TextEditorEvents["type"],
	"quillToggleBold" | "quillToggleItalic" | "quillToggleUnderline" | "quillToggleCodeBlock" | "quillToggleBlockquote"
>

const TOGGLE_EVENT: Partial<Record<keyof QuillFormats, ToggleEventType>> = {
	bold: "quillToggleBold",
	italic: "quillToggleItalic",
	underline: "quillToggleUnderline",
	"code-block": "quillToggleCodeBlock",
	blockquote: "quillToggleBlockquote"
}

const ICON: Partial<Record<keyof QuillFormats, IconName>> = {
	header: "heading",
	bold: "bold",
	italic: "italic",
	underline: "underline",
	link: "link",
	"code-block": "code",
	blockquote: "quote-right"
}

function listIcon(active: unknown): IconName {
	switch (active) {
		case "ordered": {
			return "list-ol"
		}

		case "bullet": {
			return "list-ul"
		}

		case "checked":
		case "unchecked": {
			return "list-check"
		}

		default: {
			return "list"
		}
	}
}

const BUTTON_TYPES: (keyof QuillFormats)[] = ["header", "bold", "italic", "underline", "code-block", "link", "blockquote", "list"]

const Button = ({ type, dispatch }: { type: keyof QuillFormats; dispatch: (event: TextEditorEvents) => void }) => {
	const openExternalLink = useOpenExternalLink("textEditor")

	const { t } = useTranslation()
	const active = useRichtextStore(state => state.formats[type])
	const textForeground = useResolveClassNames("text-foreground")
	const textPrimary = useResolveClassNames("text-primary")

	const menuButtons = ((): MenuButton[] => {
		switch (type) {
			case "header": {
				return [
					...Array.from({ length: 6 }, (_, i) => ({
						id: `header-${i + 1}`,
						title: String(i + 1),
						icon: "headerH" as const,
						onPress: () => {
							dispatch({ type: "quillToggleHeader", data: (i + 1) as HeaderLevel })
						}
					})),
					{
						id: "header-normal",
						title: t("normal"),
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
				if (!active) {
					return []
				}

				return [
					{
						id: "open",
						title: t("open"),
						icon: "openExternal" as const,
						onPress: () => {
							// The href comes from note content, which can be authored by another user, and
							// arrives over the WebView bridge. It goes through the same funnel as every
							// other untrusted link rather than straight to the OS — this was the one link
							// surface in the app with no scheme check and no confirmation.
							openExternalLink(active as string).catch(e =>
								logger.warn("textEditor", "failed to open a link from the richtext toolbar", { error: e })
							)
						}
					},
					{
						id: "edit",
						title: t("edit"),
						icon: "edit" as const,
						onPress: () => {
							prompts
								.input({
									title: t("edit_link"),
									message: t("enter_url"),
									placeholder: t("url_placeholder"),
									defaultValue: active as string,
									okText: t("save"),
									cancelText: t("cancel")
								})
								.then(response => {
									if (response.cancelled || !response.value.trim()) {
										return
									}

									dispatch({
										type: "quillAddLink",
										data: classifyExternalLinkHref(response.value).url
									})
								})
						}
					},
					{
						id: "remove",
						title: t("remove"),
						icon: "minus" as const,
						onPress: () => {
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
						title: t("ordered_list"),
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
						title: t("bullet_list"),
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
						title: t("checklist"),
						icon: "checklist" as const,
						onPress: () => {
							dispatch({
								type: "quillToggleList",
								data: "checklist"
							})
						}
					},
					...(active
						? [
								{
									id: "remove",
									title: t("remove"),
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
		if (type !== "link") {
			const event = TOGGLE_EVENT[type]

			if (event) {
				dispatch({
					type: event
				})
			}

			return
		}

		if (active) {
			return
		}

		prompts
			.input({
				title: t("insert_link"),
				message: t("enter_url"),
				placeholder: t("url_placeholder"),
				okText: t("insert"),
				cancelText: t("cancel")
			})
			.then(response => {
				if (response.cancelled || !response.value.trim()) {
					return
				}

				dispatch({
					type: "quillAddLink",
					data: response.value.trim()
				})
			})
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
				<FontAwesome6
					name={type === "list" ? listIcon(active) : (ICON[type] ?? "question")}
					size={ICON_SIZE}
					color={active ? (textPrimary.color as string) : (textForeground.color as string)}
				/>
				{type === "header" && active && (
					<View className="flex-row items-center justify-center absolute rounded-full size-4 -mt-4 -mr-4 overflow-hidden bg-background-secondary border border-border">
						<Text className="text-foreground text-xs">{active}</Text>
					</View>
				)}
			</PressableOpacity>
		</Menu>
	)
}

// Compact horizontal strip rendered inside the navigation header's title slot
// while the user is typing in a rich-text note. Scrolls horizontally as a
// safety net on narrow phones — the natural width (~250pt) fits inside the
// iOS title slot (~300pt usable) on every modern iPhone without scrolling.
export const RichTextHeaderToolbar = ({ dispatch }: { dispatch: (event: TextEditorEvents) => void }) => {
	return (
		<View className="items-center flex-row justify-center bg-transparent flex-1 w-full">
			<CrossGlassContainerView className={cn("h-11 overflow-hidden w-[85%]", Platform.OS === "android" && "h-10")}>
				<GestureHandlerScrollView
					horizontal={true}
					showsHorizontalScrollIndicator={false}
					showsVerticalScrollIndicator={false}
					className="flex-1"
					contentContainerClassName="flex-row items-center px-2"
				>
					{BUTTON_TYPES.map(type => (
						<Button
							key={type}
							type={type}
							dispatch={dispatch}
						/>
					))}
				</GestureHandlerScrollView>
			</CrossGlassContainerView>
		</View>
	)
}

export default RichTextHeaderToolbar
