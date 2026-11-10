import { useState } from "react"
import { useTranslation } from "react-i18next"
import { CircleAlertIcon, EllipsisIcon, PlusIcon, XIcon } from "lucide-react"
import { combosOverlap, formatChord, isCharacterChord, parseCombo, UNBOUND_COMBO, type KeyboardLayout } from "@filen/shared/keymap"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { ChordKeys } from "@/lib/keymap/kbd"
import { chordText, reservedMessage } from "@/lib/keymap/keyText"
import { comboWithout } from "@/lib/keymap/conflicts"
import { inAppMenu } from "@/lib/keymap/desktopMenu"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { resolveRecordingConflict, withoutChord } from "@/lib/keymap/recording"
import {
	clearUserCombo,
	dismissRecordingProblem,
	unbindAction,
	updateOverrides,
	type RecordingProblem,
	type ResolvedAction
} from "@/lib/keymap/registry"
import { SHORTCUT_NAMESPACES } from "@/lib/keymap/shortcutsCatalog"

const IS_MAC = isMacPlatform()

export interface ShortcutRowProps {
	action: ResolvedAction
	// This row's recording: the chord slot it replaces, null while it adds one; undefined when it is not recording.
	recordingSlot: number | null | undefined
	// The recorder listens: only then is the prompt shown, as a key pressed before is dropped.
	armed: boolean
	problem: RecordingProblem | null
	conflicts: readonly ResolvedAction[] | undefined
	characterKeys: boolean
	layout: KeyboardLayout | null
	compact: boolean
	nameOf: (id: string) => string
	onRecord: (slot: number | null) => void
	onCancel: () => void
	onSpecial: () => void
}

// One action of the shortcuts list: its name and where it works, a chip per key combination (select one to record a
// replacement, × to remove it), + to add one, and a menu to add a special key, turn the action off or reset it.
export function ShortcutRow({
	action,
	recordingSlot,
	armed,
	problem,
	conflicts,
	characterKeys,
	layout,
	compact,
	nameOf,
	onRecord,
	onCancel,
	onSpecial
}: ShortcutRowProps) {
	const { t } = useTranslation([...SHORTCUT_NAMESPACES])
	const [conflictsOpen, setConflictsOpen] = useState(false)
	const chords = parseCombo(action.combo)
	const name = t(action.descriptionKey)
	const nameId = `shortcut-${action.id}`
	const recording = recordingSlot !== undefined
	const hint = action.hintKey === undefined ? (inAppMenu(action.id) ? t("settings:keyboardHintAppMenu") : undefined) : t(action.hintKey)

	const prompt = (
		<span className="inline-flex h-6 items-center rounded-md border border-dashed border-primary/60 px-2 text-xs text-foreground">
			{armed ? t("common:shortcutsRecording") : "…"}
		</span>
	)

	return (
		<div
			className={cn(
				"flex flex-col gap-1.5 rounded-lg px-2 hover:bg-muted/40",
				compact ? "py-1.5" : "py-2",
				recording && "bg-muted/60"
			)}
		>
			<div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5">
				<div className="flex min-w-0 flex-1 basis-48 flex-col">
					<span
						id={nameId}
						className="truncate text-sm"
					>
						{name}
					</span>
					{hint !== undefined && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
				</div>
				<div className="flex flex-wrap items-center justify-end gap-1">
					{chords.length === 0 && !recording && (
						<span className="px-1 text-xs text-muted-foreground">{t("common:shortcutsUnbound")}</span>
					)}
					{chords.map((chord, slot) => {
						const formatted = formatChord(chord)

						if (recordingSlot === slot) {
							return <span key={formatted}>{prompt}</span>
						}

						const off = !characterKeys && action.keepsCharacterKeys !== true && isCharacterChord(chord)
						const keys = chordText(chord, layout)

						return (
							<span
								key={formatted}
								className={cn("inline-flex items-center rounded-md bg-muted/70 ring-1 ring-border/60", off && "opacity-50")}
								title={off ? t("settings:keyboardCharacterKeyOff") : undefined}
							>
								<button
									type="button"
									className="inline-flex h-6 items-center rounded-l-md pr-1 pl-1.5 focus-ring outline-none hover:bg-muted"
									aria-label={t("settings:keyboardChangeKeys", { keys })}
									aria-describedby={nameId}
									onClick={() => {
										onRecord(slot)
									}}
								>
									<ChordKeys
										chord={chord}
										layout={layout}
									/>
								</button>
								<button
									type="button"
									className="inline-flex size-6 items-center justify-center rounded-r-md text-muted-foreground focus-ring outline-none hover:bg-muted hover:text-foreground"
									aria-label={t("settings:keyboardRemoveKeys", { keys })}
									aria-describedby={nameId}
									onClick={() => {
										const rest = withoutChord(action.combo, slot)

										void updateOverrides({ [action.id]: rest === "" ? UNBOUND_COMBO : rest })
									}}
								>
									<XIcon
										aria-hidden="true"
										className="size-3"
									/>
								</button>
							</span>
						)
					})}
					{recordingSlot === null && prompt}
					{/* One button that toggles, never two that swap: React keeps this element (and the focus on it) across
					    the change, which is what lets the list's Escape capture handler see the keypress. */}
					<Button
						variant="ghost"
						size={recording ? "sm" : "icon-sm"}
						aria-label={recording ? t("common:cancel") : t("settings:keyboardAdd")}
						aria-describedby={nameId}
						onClick={() => {
							if (recording) {
								onCancel()
							} else {
								onRecord(null)
							}
						}}
					>
						{recording ? t("common:cancel") : <PlusIcon />}
					</Button>
					{conflicts !== undefined && !recording && (
						<Button
							variant="ghost"
							size="sm"
							className="text-destructive"
							aria-expanded={conflictsOpen}
							aria-describedby={nameId}
							onClick={() => {
								setConflictsOpen(open => !open)
							}}
						>
							<CircleAlertIcon data-icon="inline-start" />
							{t("settings:keyboardConflict")}
						</Button>
					)}
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={t("settings:keyboardMore")}
									aria-describedby={nameId}
								>
									<EllipsisIcon />
								</Button>
							}
						/>
						<DropdownMenuContent align="end">
							<DropdownMenuGroup>
								<DropdownMenuItem onClick={onSpecial}>{t("settings:keyboardAddSpecial")}</DropdownMenuItem>
								<DropdownMenuItem
									disabled={action.combo.length === 0}
									onClick={() => {
										void unbindAction(action.id)
									}}
								>
									{t("settings:keyboardTurnOff")}
								</DropdownMenuItem>
							</DropdownMenuGroup>
							<DropdownMenuSeparator />
							<DropdownMenuGroup>
								<DropdownMenuItem
									disabled={!action.overridden}
									onClick={() => {
										void clearUserCombo(action.id)
									}}
								>
									{t("common:shortcutsResetToDefault")}
								</DropdownMenuItem>
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			{problem !== null && (
				<RowProblem
					problem={problem}
					layout={layout}
					nameOf={nameOf}
				/>
			)}
			{conflictsOpen && conflicts !== undefined && problem === null && (
				<ExistingConflicts
					action={action}
					conflicts={conflicts}
					nameOf={nameOf}
				/>
			)}
		</div>
	)
}

function chordTextOf(combo: string, layout: KeyboardLayout | null): string {
	const [chord] = parseCombo(combo)

	return chord === undefined ? combo : chordText(chord, layout)
}

// Why the last recording was not simply saved: the actions already holding the keys, with Reassign and Swap, or a
// key the browser or the system keeps.
function RowProblem({
	problem,
	layout,
	nameOf
}: {
	problem: RecordingProblem
	layout: KeyboardLayout | null
	nameOf: (id: string) => string
}) {
	const { t } = useTranslation(["settings", "common"])
	const { t: settingsT } = useTranslation("settings")
	const keys = chordTextOf(problem.chord, layout)

	if (problem.kind === "reserved") {
		return (
			<div
				className={cn(
					"flex items-center justify-between gap-2 text-xs",
					problem.blocked ? "text-destructive" : "text-muted-foreground"
				)}
			>
				<span>{reservedMessage(settingsT, problem.owner, keys)}</span>
				<Button
					variant="ghost"
					size="xs"
					onClick={dismissRecordingProblem}
				>
					{t("keyboardDismiss")}
				</Button>
			</div>
		)
	}

	const canSwap = problem.replaced !== null && problem.conflictIds.length === 1

	return (
		<div className="flex flex-col gap-2 rounded-md bg-destructive/5 p-2 text-xs">
			<span
				role="alert"
				className="text-destructive"
			>
				{t("keyboardConflictWith", { keys, actions: problem.conflictIds.map(nameOf).join(", ") })}
			</span>
			<div className="flex flex-wrap gap-1">
				<Button
					variant="outline"
					size="xs"
					onClick={() => {
						void resolveRecordingConflict("reassign")
					}}
				>
					{t("keyboardReassign")}
				</Button>
				{canSwap && (
					<Button
						variant="outline"
						size="xs"
						onClick={() => {
							void resolveRecordingConflict("swap")
						}}
					>
						{t("keyboardSwap")}
					</Button>
				)}
				<Button
					variant="ghost"
					size="xs"
					onClick={dismissRecordingProblem}
				>
					{t("common:cancel")}
				</Button>
			</div>
		</div>
	)
}

// The actions this one already shares keys with, each with a button that takes the shared keys off it.
function ExistingConflicts({
	action,
	conflicts,
	nameOf
}: {
	action: ResolvedAction
	conflicts: readonly ResolvedAction[]
	nameOf: (id: string) => string
}) {
	const { t } = useTranslation("settings")
	const own = parseCombo(action.combo).map(formatChord)

	return (
		<ul className="flex flex-col gap-1 rounded-md bg-destructive/5 p-2 text-xs">
			{conflicts.map(other => (
				<li
					key={other.id}
					className="flex items-center justify-between gap-2"
				>
					<span className="min-w-0 truncate">{nameOf(other.id)}</span>
					<Button
						variant="outline"
						size="xs"
						onClick={() => {
							const left = own
								.filter(chord => combosOverlap(chord, other.combo, IS_MAC))
								.reduce(
									(combo, chord) => (combo === UNBOUND_COMBO ? combo : comboWithout(combo, chord, IS_MAC)),
									other.combo
								)

							void updateOverrides({ [other.id]: left })
						}}
					>
						{t("keyboardRemoveThere", { action: nameOf(other.id) })}
					</Button>
				</li>
			))}
		</ul>
	)
}
