import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useNameConflictAsk, type NameConflictAsk } from "@/features/drive/lib/nameConflictAsk"
import { choiceFor, primaryChoice, type ConflictChoice, type NestedPolicy } from "@/features/drive/lib/nameConflicts"

const NESTED_POLICIES = [
	{ value: "replace", key: "driveConflictNestedReplace" },
	{ value: "skip", key: "driveConflictNestedSkip" },
	{ value: "keepBoth", key: "driveConflictNestedKeepBoth" }
] as const

function isNestedPolicy(value: unknown): value is NestedPolicy {
	return value === "replace" || value === "skip" || value === "keepBoth"
}

export interface NameConflictPromptProps {
	ask: NameConflictAsk
}

// One ask's prompt: the clashes one at a time, or one choice for all that remain. A dismissal skips every clash not
// decided yet.
export function NameConflictPrompt({ ask }: NameConflictPromptProps) {
	const { t } = useTranslation("drive")
	const id = useId()
	const { conflicts, operation } = ask
	const [position, setPosition] = useState(0)
	const [choices, setChoices] = useState<ConflictChoice[]>([])
	const [applyToAll, setApplyToAll] = useState(false)
	const [nested, setNested] = useState<NestedPolicy>("replace")
	const conflict = conflicts[position]

	if (conflict === undefined) {
		return null
	}

	const remaining = conflicts.length - position
	const primary = primaryChoice(conflict, operation)

	function choose(choice: ConflictChoice): void {
		const next = [...choices]

		if (applyToAll) {
			for (let index = position; index < conflicts.length; index++) {
				const other = conflicts[index]

				if (other !== undefined) {
					next[index] = choiceFor(other, operation, choice)
				}
			}
		} else {
			next[position] = choice
		}

		if (applyToAll || position + 1 >= conflicts.length) {
			ask.settle({ choices: next, nested })

			return
		}

		setChoices(next)
		setPosition(position + 1)
	}

	function dismiss(): void {
		ask.settle({ choices: conflicts.map((_, index) => choices[index] ?? "skip"), nested })
	}

	return (
		<Dialog
			open
			onOpenChange={open => {
				if (!open) {
					dismiss()
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{conflicts.length === 1
							? t("driveConflictTitleSingle", { name: conflict.name, destination: ask.destination })
							: t("driveConflictTitle", { count: conflicts.length, destination: ask.destination })}
					</DialogTitle>
					<DialogDescription>
						{conflicts.length > 1 ? (
							<>{t("driveConflictItem", { name: conflict.name, position: position + 1, count: conflicts.length })} </>
						) : null}
						{t(conflict.existing === "file" ? "driveConflictExistingFile" : "driveConflictExistingDirectory")}{" "}
						{primary === "replace"
							? t(ask.versioning ? "driveConflictReplaceVersioned" : "driveConflictReplaceUnversioned")
							: primary === "merge"
								? t("driveConflictMergeHint")
								: null}
					</DialogDescription>
				</DialogHeader>
				{primary === "merge" ? (
					<fieldset className="flex flex-col gap-3">
						<legend className="mb-3 text-sm font-medium">{t("driveConflictNestedLabel")}</legend>
						<RadioGroup
							aria-label={t("driveConflictNestedLabel")}
							name={`${id}-nested`}
							value={nested}
							onValueChange={value => {
								if (isNestedPolicy(value)) {
									setNested(value)
								}
							}}
						>
							{NESTED_POLICIES.map(policy => (
								<div
									key={policy.value}
									className="flex items-center gap-3"
								>
									<RadioGroupItem
										id={`${id}-${policy.value}`}
										value={policy.value}
									/>
									<Label htmlFor={`${id}-${policy.value}`}>{t(policy.key)}</Label>
								</div>
							))}
						</RadioGroup>
					</fieldset>
				) : null}
				{remaining > 1 ? (
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							className="size-4 accent-primary"
							checked={applyToAll}
							onChange={event => {
								setApplyToAll(event.target.checked)
							}}
						/>
						{t("driveConflictApplyToAll", { count: remaining })}
					</label>
				) : null}
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => {
							choose("skip")
						}}
					>
						{t("driveConflictSkip")}
					</Button>
					<Button
						variant={primary === undefined ? "default" : "outline"}
						onClick={() => {
							choose("keepBoth")
						}}
					>
						{t("driveConflictKeepBoth")}
					</Button>
					{primary === undefined ? null : (
						<Button
							autoFocus
							onClick={() => {
								choose(primary)
							}}
						>
							{t(primary === "replace" ? "driveConflictReplace" : "driveConflictMerge")}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

// The prompt of an upload's or a move's name conflicts (lib/nameConflictAsk.ts), mounted once at the root. Keyed by
// ask, so each starts at its first clash.
export function NameConflictDialog() {
	const ask = useNameConflictAsk()

	return ask === null ? null : (
		<NameConflictPrompt
			key={ask.id}
			ask={ask}
		/>
	)
}
