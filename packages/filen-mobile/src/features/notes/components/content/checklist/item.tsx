import { useRef, useEffect, useState } from "react"
import { TextInput, type TextInputKeyPressEvent, type TextInputSubmitEditingEvent } from "react-native"
import MaterialIcons from "@expo/vector-icons/MaterialIcons"
import { useResolveClassNames } from "uniwind"
import { type ChecklistItem, checklistParser, cn } from "@filen/utils"
import { PressableOpacity } from "@/components/ui/pressables"
import View from "@/components/ui/view"
import useChecklistStore from "@/features/notes/store/useChecklist.store"
import { addChecklistLine, removeChecklistItem } from "@/features/notes/checklistEdit"
import { useShallow } from "zustand/shallow"
import { randomUUID } from "expo-crypto"

function normalizeItemContent(content: string): string {
	return content.replace(/\r?\n/g, "")
}

const Item = ({
	id,
	onContentChange,
	onCheckedChange,
	onChange,
	readOnly,
	onDidType,
	autoFocus,
	isLast
}: {
	id: string
	onContentChange: ({ item, content }: { item: ChecklistItem; content: string }) => void
	onCheckedChange: ({ item, checked }: { item: ChecklistItem; checked: boolean }) => void
	onChange?: (value: string) => void
	readOnly?: boolean
	onDidType: () => void
	autoFocus?: boolean
	isLast?: boolean
}) => {
	const textInputRef = useRef<TextInput>(null)
	const bgBackground = useResolveClassNames("bg-background")
	const textPrimary = useResolveClassNames("text-primary")
	const item = useChecklistStore(useShallow(state => state.parsed.find(i => i.id === id)))

	const [value, setValue] = useState<string>(() => normalizeItemContent(item?.content ?? ""))

	const toggleChecked = () => {
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
	}

	const onChangeText = (text: string) => {
		if (!item) {
			return
		}

		const content = normalizeItemContent(text)

		// onChangeText only fires for genuine user input (programmatic hydration writes the
		// store directly and seeds `value` via the useState initializer, never through here).
		// On Android soft keyboards onKeyPress does not fire for ordinary character keys, so this
		// is the only reliable signal that the user has actually typed — without it, didType stays
		// false and edits are never propagated to the parent / synced.
		onDidType()

		setValue(content)
		onContentChange({
			item,
			content
		})
	}

	const focus = () => {
		textInputRef?.current?.focus()
	}

	const focusItem = (id: string) => {
		const ref = useChecklistStore.getState().inputRefs[id]
		const content = useChecklistStore.getState().parsed.find(i => i.id === id)?.content ?? ""

		ref?.current?.setSelection(content.length, content.length)
		ref?.current?.focus()
	}

	const addNewLine = (after: ChecklistItem) => {
		const parsed = useChecklistStore.getState().parsed
		const result = addChecklistLine(parsed, after.id, randomUUID())

		if (!result.changed) {
			if (result.focusId) {
				focusItem(result.focusId)
			}

			return
		}

		useChecklistStore.getState().setParsed(result.next)
		useChecklistStore.getState().setIds(result.next.map(i => i.id))

		// Propagate the structural edit to the parent so the inflight-content sync fires immediately.
		// Without this the new row is only persisted on the next keystroke (onChangeText), so a row
		// added with Enter and left empty would be lost on reopen. Mirrors onCheckedChange in the
		// parent Checklist, reading the freshly-written store state so the value is never stale.
		if (onChange) {
			onChange(checklistParser.stringify(useChecklistStore.getState().parsed))
		}

		// Defer focus: the new <Item> for the added row has not mounted yet, so its ref-registration
		// useEffect has not run and inputRefs[id] is still undefined. A macrotask runs after React
		// has committed the render and flushed the passive effect, so the ref is registered by then
		// (matches the focus-after-mount deferral used by the chat input).
		if (result.focusId) {
			const focusId = result.focusId

			setTimeout(() => {
				focusItem(focusId)
			}, 0)
		}
	}

	const removeItem = (item: ChecklistItem) => {
		const parsed = useChecklistStore.getState().parsed
		const result = removeChecklistItem(parsed, item.id, randomUUID())

		if (!result.changed) {
			return
		}

		useChecklistStore.getState().setParsed(result.next)
		useChecklistStore.getState().setIds(result.next.map(i => i.id))

		// Propagate the deletion (and the single-item reset) to the parent so the inflight-content
		// sync fires. Without this the row is removed from the store/UI but never persisted, so the
		// deleted item reappears from the server on reopen (data loss). Mirrors onCheckedChange in
		// the parent Checklist, reading the freshly-written store state so the value is never stale.
		if (onChange) {
			onChange(checklistParser.stringify(useChecklistStore.getState().parsed))
		}

		if (result.focusId) {
			focusItem(result.focusId)
		}
	}

	const onSubmitEditing = (e: TextInputSubmitEditingEvent) => {
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
	}

	const onKeyPress = (e: TextInputKeyPressEvent) => {
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
	}

	useEffect(() => {
		if (item?.id == null) {
			return
		}

		useChecklistStore.getState().setInputRefs(prev => ({
			...prev,
			[id]: textInputRef
		}))
	}, [item?.id, id])

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

export default Item
