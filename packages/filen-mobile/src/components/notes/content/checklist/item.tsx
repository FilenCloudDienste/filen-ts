import { useRef, useEffect, useState, memo, useCallback } from "react"
import { TextInput, type TextInputKeyPressEvent, type TextInputSubmitEditingEvent } from "react-native"
import MaterialIcons from "@expo/vector-icons/MaterialIcons"
import { useResolveClassNames } from "uniwind"
import { type ChecklistItem, cn } from "@filen/utils"
import { PressableOpacity } from "@/components/ui/pressables"
import View from "@/components/ui/view"
import useChecklistStore from "@/stores/useChecklist.store"
import { useShallow } from "zustand/shallow"
import { randomUUID } from "expo-crypto"

export const Item = memo(
	({
		id,
		onContentChange,
		onCheckedChange,
		readOnly,
		onDidType,
		autoFocus,
		isLast
	}: {
		id: string
		onContentChange: ({ item, content }: { item: ChecklistItem; content: string }) => void
		onCheckedChange: ({ item, checked }: { item: ChecklistItem; checked: boolean }) => void
		readOnly?: boolean
		onDidType: () => void
		autoFocus?: boolean
		isLast?: boolean
	}) => {
		const textInputRef = useRef<TextInput>(null)
		const bgBackground = useResolveClassNames("bg-background")
		const textPrimary = useResolveClassNames("text-primary")
		const item = useChecklistStore(useShallow(state => state.parsed.find(i => i.id === id)))

		const normalizeItemContent = useCallback((content: string) => {
			return content.replace(/\r?\n/g, "")
		}, [])

		const [value, setValue] = useState<string>(() => normalizeItemContent(item?.content ?? ""))

		const toggleChecked = useCallback(() => {
			if (!item) {
				return
			}

			if (!item.checked && normalizeItemContent(item.content).trim().length === 0) {
				return
			}

			onCheckedChange({
				item,
				checked: !item.checked
			})

			onDidType()
		}, [onCheckedChange, item, onDidType, normalizeItemContent])

		const onChangeText = useCallback(
			(text: string) => {
				if (!item) {
					return
				}

				const content = normalizeItemContent(text)

				setValue(content)
				onContentChange({
					item,
					content
				})
			},
			[onContentChange, item, normalizeItemContent]
		)

		const focus = useCallback(() => {
			textInputRef?.current?.focus()
		}, [])

		const focusItem = useCallback((id: string) => {
			const ref = useChecklistStore.getState().inputRefs[id]
			const content = useChecklistStore.getState().parsed.find(i => i.id === id)?.content ?? ""

			ref?.current?.setSelection(content.length, content.length)
			ref?.current?.focus()
		}, [])

		const addNewLine = useCallback(
			(after: ChecklistItem) => {
				const parsed = useChecklistStore.getState().parsed
				const nextIndex = parsed.findIndex(i => i.id === after.id) + 1

				if (nextIndex > 0 && parsed[nextIndex] && parsed[nextIndex].content.trim().length === 0) {
					focusItem(parsed[nextIndex].id)

					return
				}

				const id = randomUUID()

				useChecklistStore.getState().setParsed(prev => {
					const newList = [...prev]
					const index = prev.findIndex(i => i.id === after.id)

					newList.splice(index + 1, 0, {
						id,
						checked: false,
						content: ""
					})

					useChecklistStore.getState().setIds(newList.map(i => i.id))

					return newList
				})

				focusItem(id)
			},
			[focusItem]
		)

		const removeItem = useCallback(
			(item: ChecklistItem) => {
				const parsed = useChecklistStore.getState().parsed

				if (parsed.length === 1) {
					const id = randomUUID()

					useChecklistStore.getState().setParsed([
						{
							id,
							checked: false,
							content: ""
						}
					])

					useChecklistStore.getState().setIds([id])

					return
				}

				const index = parsed.findIndex(i => i.id === item.id)

				if (index === -1 || index === 0) {
					return
				}

				const prevItem = parsed[index - 1]

				useChecklistStore.getState().setParsed(prev => {
					const newList = prev.filter(i => i.id !== item.id)

					useChecklistStore.getState().setIds(newList.map(i => i.id))

					return newList
				})

				if (prevItem) {
					focusItem(prevItem.id)
				}
			},
			[focusItem]
		)

		const onSubmitEditing = useCallback(
			(e: TextInputSubmitEditingEvent) => {
				if (!item) {
					return
				}

				e.preventDefault()
				e.stopPropagation()

				if (normalizeItemContent(item.content).length > 0) {
					addNewLine(item)
				} else {
					focus()
				}
			},
			[item, addNewLine, focus, normalizeItemContent]
		)

		const onKeyPress = useCallback(
			(e: TextInputKeyPressEvent) => {
				if (!item) {
					return
				}

				e.preventDefault()
				e.stopPropagation()

				onDidType()

				if (e.nativeEvent.key === "Enter") {
					onSubmitEditing(e as unknown as TextInputSubmitEditingEvent)
				}

				if (e.nativeEvent.key === "Backspace" && normalizeItemContent(item.content).length === 0) {
					removeItem(item)
				}
			},
			[item, removeItem, onDidType, onSubmitEditing, normalizeItemContent]
		)

		useEffect(() => {
			if (!item) {
				return
			}

			useChecklistStore.getState().setInputRefs(prev => ({
				...prev,
				[item.id]: textInputRef
			}))
		}, [item])

		if (!item) {
			return null
		}

		return (
			<View className="flex-row flex-1 items-center gap-2">
				<View className={cn("flex-row items-center self-start shrink-0", readOnly && "opacity-50")}>
					{item.checked ? (
						<PressableOpacity
							rippleColor="transparent"
							className="flex-row items-center justify-center w-5 h-5 rounded-full"
							style={{
								backgroundColor: textPrimary.color as string
							}}
							onPress={toggleChecked}
							hitSlop={10}
							enabled={!readOnly}
						>
							<MaterialIcons
								name="check"
								size={16}
								color={bgBackground.backgroundColor}
							/>
						</PressableOpacity>
					) : (
						<PressableOpacity
							rippleColor="transparent"
							className="flex-row items-center justify-center w-5 h-5 bg-gray-500 rounded-full"
							onPress={toggleChecked}
							hitSlop={10}
							enabled={!readOnly}
						>
							<View className="rounded-full w-[18.5px] h-[18.5px] bg-background" />
						</PressableOpacity>
					)}
				</View>
				<TextInput
					ref={textInputRef}
					className="text-foreground shrink-0 flex-1 bg-transparent py-0 my-0"
					value={value}
					onChangeText={onChangeText}
					multiline={true}
					scrollEnabled={false}
					onPress={focus}
					onSubmitEditing={onSubmitEditing}
					onKeyPress={onKeyPress}
					returnKeyType="next"
					keyboardType="default"
					keyboardAppearance="default"
					autoCapitalize="none"
					autoComplete="off"
					autoCorrect={false}
					spellCheck={false}
					enablesReturnKeyAutomatically={true}
					autoFocus={autoFocus && isLast}
					editable={!readOnly}
				/>
			</View>
		)
	}
)

export default Item
