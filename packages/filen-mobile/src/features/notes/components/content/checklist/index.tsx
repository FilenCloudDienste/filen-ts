import { useRef, useEffect, Fragment } from "react"
import { KeyboardAwareScrollView } from "@/components/ui/view"
import { checklistParser, type ChecklistItem } from "@filen/utils"
import Item from "@/features/notes/components/content/checklist/item"
import useChecklistStore from "@/features/notes/store/useChecklist.store"
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
	// Client-side filter only: hideCompleted drops checked items from the rendered list without
	// touching `parsed` (the source of truth that gets stringified back into the note), so the
	// original note content is preserved. useShallow keeps the render stable when off (same ids ref)
	// and only re-renders when the visible set actually changes (e.g. an item is checked/unchecked),
	// not on every keystroke.
	const visibleIds = useChecklistStore(useShallow(state => visibleChecklistIds(state.ids, state.parsed, hideCompleted ?? false)))

	const onContentChange = ({ item, content }: { item: ChecklistItem; content: string }) => {
		useChecklistStore.getState().setParsed(prev =>
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
			const parsed = useChecklistStore.getState().parsed

			onChange(checklistParser.stringify(parsed))
		}
	}

	const onCheckedChange = ({ item, checked }: { item: ChecklistItem; checked: boolean }) => {
		useChecklistStore.getState().setParsed(prev =>
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
			const parsed = useChecklistStore.getState().parsed

			onChange(checklistParser.stringify(parsed))
		}
	}

	const onTyped = () => {
		didTypeRef.current = true
	}

	useEffect(() => {
		let parsed = initialValue ? checklistParser.parse(initialValue) : []

		if (parsed.length === 0) {
			parsed = [
				{
					id: randomUUID(),
					checked: false,
					content: ""
				}
			]
		}

		useChecklistStore.getState().setInputRefs({})
		useChecklistStore.getState().setInitialIds(
			parsed.reduce(
				(acc, item) => {
					acc[item.id] = true

					return acc
				},
				{} as Record<string, boolean>
			)
		)
		useChecklistStore.getState().setParsed(parsed)
		useChecklistStore.getState().setIds(parsed.map(i => i.id))
	}, [initialValue])

	return (
		<Fragment>
			<KeyboardAwareScrollView
				className="flex-1"
				contentInsetAdjustmentBehavior="automatic"
				contentContainerClassName="p-4 flex-col pb-32 gap-4"
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
							readOnly={readOnly}
							onDidType={onTyped}
							isLast={index === visibleIds.length - 1}
							autoFocus={autoFocus}
						/>
					)
				})}
			</KeyboardAwareScrollView>
			{!readOnly && <Toolbar />}
		</Fragment>
	)
}

export default Checklist
