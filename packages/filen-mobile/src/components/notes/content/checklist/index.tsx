import { useState, useEffect, Fragment, memo, useCallback } from "react"
import { KeyboardAwareScrollView } from "@/components/ui/view"
import { checklistParser, type ChecklistItem } from "@filen/utils"
import Item from "@/components/notes/content/checklist/item"
import useChecklistStore from "@/stores/useChecklist.store"
import { useShallow } from "zustand/shallow"
import { randomUUID } from "expo-crypto"
import Toolbar from "@/components/notes/content/checklist/toolbar"

export const Checklist = memo(
	({
		initialValue,
		onChange,
		readOnly,
		autoFocus
	}: {
		initialValue?: string
		onChange?: (value: string) => void
		readOnly?: boolean
		autoFocus?: boolean
	}) => {
		const [didType, setDidType] = useState<boolean>(false)
		const ids = useChecklistStore(useShallow(state => state.ids))

		const onContentChange = useCallback(
			({ item, content }: { item: ChecklistItem; content: string }) => {
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

				if (didType && onChange) {
					const parsed = useChecklistStore.getState().parsed

					onChange(checklistParser.stringify(parsed))
				}
			},
			[didType, onChange]
		)

		const onCheckedChange = useCallback(
			({ item, checked }: { item: ChecklistItem; checked: boolean }) => {
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
			},
			[onChange]
		)

		const onTyped = useCallback(() => {
			setDidType(true)
		}, [])

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
					{ids.map((id, index) => {
						return (
							<Item
								key={id}
								id={id}
								onContentChange={onContentChange}
								onCheckedChange={onCheckedChange}
								readOnly={readOnly}
								onDidType={onTyped}
								isLast={index === ids.length - 1}
								autoFocus={autoFocus}
							/>
						)
					})}
				</KeyboardAwareScrollView>
				{!readOnly && <Toolbar />}
			</Fragment>
		)
	}
)

export default Checklist
