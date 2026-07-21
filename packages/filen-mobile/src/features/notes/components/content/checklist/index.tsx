import { useRef, useEffect, useState } from "react"
import { useHeaderHeight } from "expo-router/react-navigation"
import { Platform } from "react-native"
import { useStore } from "zustand"
import { KeyboardAwareScrollView } from "@/components/ui/view"
import { checklistParser, type ChecklistItem } from "@filen/utils"
import Item from "@/features/notes/components/content/checklist/item"
import { createChecklistStore, ChecklistStoreContext } from "@/features/notes/store/useChecklist.store"
import { useShallow } from "zustand/shallow"
import { randomUUID } from "expo-crypto"
import Toolbar from "@/features/notes/components/content/checklist/toolbar"
import { visibleChecklistIds } from "@/features/notes/checklistView"

const Checklist = ({
	initialValue,
	onChange,
	readOnly,
	autoFocus,
	hideCompleted
}: {
	initialValue?: string
	onChange?: (value: string) => void
	readOnly?: boolean
	autoFocus?: boolean
	hideCompleted?: boolean
}) => {
	// didType gates onChange so programmatic hydration (the initialValue useEffect below, which
	// writes the store directly) never propagates a spurious onChange. It is a ref, not state,
	// so it reads the up-to-date value synchronously within the same event that flips it —
	// otherwise the first keystroke would be dropped while a state update is still pending.
	const didTypeRef = useRef<boolean>(false)
	// Per-INSTANCE store so two mounted editors (e.g. a live note + a history "View" of the same
	// uuid) never share checklist state. The lazy useState initializer runs once per mount and is
	// safe to read during render (unlike useRef().current under react-hooks/refs); GC'd with the component.
	const [store] = useState(() => createChecklistStore())
	// Client-side filter only: hideCompleted drops checked items from the rendered list without
	// touching `parsed` (the source of truth that gets stringified back into the note), so the
	// original note content is preserved. useShallow keeps the render stable when off (same ids ref)
	// and only re-renders when the visible set actually changes (e.g. an item is checked/unchecked),
	// not on every keystroke.
	const visibleIds = useStore(
		store,
		useShallow(state => visibleChecklistIds(state.ids, state.parsed, hideCompleted ?? false))
	)
	const initialValueFrozen = useState(() => initialValue)[0]
	const headerHeight = useHeaderHeight()

	const onContentChange = ({ item, content }: { item: ChecklistItem; content: string }) => {
		store.getState().setParsed(prev =>
			prev.map(i =>
				i.id === item.id
					? {
							...i,
							content
						}
					: i
			)
		)

		if (didTypeRef.current && onChange) {
			const parsed = store.getState().parsed

			onChange(checklistParser.stringify(parsed))
		}
	}

	const onCheckedChange = ({ item, checked }: { item: ChecklistItem; checked: boolean }) => {
		store.getState().setParsed(prev =>
			prev.map(i =>
				i.id === item.id
					? {
							...i,
							checked
						}
					: i
			)
		)

		if (onChange) {
			const parsed = store.getState().parsed

			onChange(checklistParser.stringify(parsed))
		}
	}

	const onTyped = () => {
		didTypeRef.current = true
	}

	useEffect(() => {
		let parsed = initialValueFrozen ? checklistParser.parse(initialValueFrozen) : []

		if (parsed.length === 0) {
			parsed = [
				{
					id: randomUUID(),
					checked: false,
					content: ""
				}
			]
		}

		store.getState().setInputRefs({})
		store.getState().setInitialIds(
			parsed.reduce(
				(acc, item) => {
					acc[item.id] = true

					return acc
				},
				{} as Record<string, boolean>
			)
		)
		store.getState().setParsed(parsed)
		store.getState().setIds(parsed.map(i => i.id))
	}, [store, initialValueFrozen])

	return (
		<ChecklistStoreContext.Provider value={store}>
			<KeyboardAwareScrollView
				className="flex-1"
				// iOS: explicit header offset instead of contentInsetAdjustmentBehavior="automatic" —
				// the automatic inset makes the resting contentOffset NEGATIVE under the translucent
				// header, while KeyboardAwareScrollView's caret-follow scrolls compute (and 0-clamp)
				// their targets assuming top = offset 0; with a hardware keyboard (keyboardHeight 0)
				// an Enter/Backspace caret hop could park the whole list under the header (#79).
				// With padding the offset space genuinely starts at 0, the library's math is
				// consistent, and under-header is geometrically unreachable. Android's opaque header
				// lays the scroll view out BELOW itself (the automatic inset was an iOS no-op), so
				// the extra padding must not apply there.
				contentContainerClassName="p-4 flex-col pb-32 gap-4"
				contentContainerStyle={Platform.select({
					ios: {
						paddingTop: headerHeight + 16
					}
				})}
				scrollIndicatorInsets={Platform.select({
					ios: {
						top: headerHeight
					}
				})}
				keyboardShouldPersistTaps="always"
				keyboardDismissMode="interactive"
				bottomOffset={32}
			>
				{visibleIds.map((id, index) => {
					return (
						<Item
							key={id}
							id={id}
							onContentChange={onContentChange}
							onCheckedChange={onCheckedChange}
							onChange={onChange}
							readOnly={readOnly}
							onDidType={onTyped}
							isLast={index === visibleIds.length - 1}
							autoFocus={autoFocus}
						/>
					)
				})}
			</KeyboardAwareScrollView>
			{!readOnly && <Toolbar />}
		</ChecklistStoreContext.Provider>
	)
}

export default Checklist
