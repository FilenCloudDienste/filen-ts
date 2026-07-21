import { useRef, useEffect, useState, useContext } from "react"
import { useStore } from "zustand"
import { TextInput, type TextInputKeyPressEvent, type TextInputSubmitEditingEvent } from "react-native"
import MaterialIcons from "@expo/vector-icons/MaterialIcons"
import { useResolveClassNames } from "uniwind"
import { type ChecklistItem, checklistParser, cn } from "@filen/utils"
import { PressableOpacity } from "@/components/ui/pressables"
import View from "@/components/ui/view"
import { ChecklistStoreContext } from "@/features/notes/store/useChecklist.store"
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
	// Dedupes one physical Enter press reaching us twice (native onSubmitEditing + the key event —
	// platform-dependent which fire). Genuine repeat presses are slower than this window.
	const lastEnterAtRef = useRef<number>(0)
	// Bumped when normalization STRIPPED characters from the native text (a leaked newline, a
	// multi-line paste). setValue alone can't fix the native field then: the normalized value
	// usually equals the current state, React bails out without committing, and the native input
	// keeps the stripped characters forever (#79 — text/cursor rendered a line low until an
	// unrelated re-render finally reconciled it). A state bump forces the commit; RN's TextInput
	// then diffs `value` against the native text and rewrites the field.
	const [, setNativeSyncCounter] = useState<number>(0)
	const bgBackground = useResolveClassNames("bg-background")
	const textPrimary = useResolveClassNames("text-primary")
	// Per-INSTANCE store from the nearest <Checklist> Provider. Always present in practice (<Item> is
	// only ever rendered inside <Checklist>); the throw guards the developer-error case so the rest of
	// the component can treat `store` as non-null without an assertion.
	const store = useContext(ChecklistStoreContext)

	if (!store) {
		throw new Error("Checklist Item must be rendered within a ChecklistStoreContext.Provider")
	}

	const item = useStore(
		store,
		useShallow(state => state.parsed.find(i => i.id === id))
	)

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

		if (content !== text) {
			setNativeSyncCounter(n => n + 1)
		}

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
		const ref = store.getState().inputRefs[id]
		const content = store.getState().parsed.find(i => i.id === id)?.content ?? ""

		ref?.current?.setSelection(content.length, content.length)
		ref?.current?.focus()
	}

	const addNewLine = (after: ChecklistItem) => {
		const parsed = store.getState().parsed
		const result = addChecklistLine(parsed, after.id, randomUUID())

		if (!result.changed) {
			if (result.focusId) {
				focusItem(result.focusId)
			}

			return
		}

		store.getState().setParsed(result.next)
		store.getState().setIds(result.next.map(i => i.id))

		// Propagate the structural edit to the parent so the inflight-content sync fires immediately.
		// Without this the new row is only persisted on the next keystroke (onChangeText), so a row
		// added with Enter and left empty would be lost on reopen. Mirrors onCheckedChange in the
		// parent Checklist, reading the freshly-written store state so the value is never stale.
		if (onChange) {
			onChange(checklistParser.stringify(store.getState().parsed))
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
		const parsed = store.getState().parsed
		const result = removeChecklistItem(parsed, item.id, randomUUID())

		if (!result.changed) {
			return
		}

		store.getState().setParsed(result.next)
		store.getState().setIds(result.next.map(i => i.id))

		// Propagate the deletion (and the single-item reset) to the parent so the inflight-content
		// sync fires. Without this the row is removed from the store/UI but never persisted, so the
		// deleted item reappears from the server on reopen (data loss). Mirrors onCheckedChange in
		// the parent Checklist, reading the freshly-written store state so the value is never stale.
		if (onChange) {
			onChange(checklistParser.stringify(store.getState().parsed))
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

		const now = Date.now()

		if (now - lastEnterAtRef.current < 100) {
			return
		}

		lastEnterAtRef.current = now

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

		store.getState().setInputRefs(prev => ({
			...prev,
			[id]: textInputRef
		}))

		// Drop this item's ref on unmount (or id change) so a dismissed editor leaves no foreign refs
		// in the store. With the per-instance store this is also collected with the component, but the
		// explicit cleanup keeps inputRefs accurate while the editor stays mounted (rows added/removed).
		return () => {
			store.getState().setInputRefs(prev => {
				const next = {
					...prev
				}

				delete next[id]

				return next
			})
		}
	}, [item?.id, id, store])

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
				className="text-foreground leading-5 shrink-0 flex-1 bg-transparent py-0 my-0"
				value={value}
				onChangeText={onChangeText}
				multiline={true}
				// Enter SUBMITS (fires onSubmitEditing, keeps focus) instead of the multiline
				// default of inserting a newline into the native field — the newline is what
				// left the input a line taller than its value (#79); onChangeText's stripped-
				// character resync above remains as the belt (hardware keyboards, paste).
				submitBehavior="submit"
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
