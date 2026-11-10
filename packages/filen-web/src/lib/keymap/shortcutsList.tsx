import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { useRecordHotkeys } from "react-hotkeys-hook"
import { ChevronDownIcon, ChevronRightIcon, KeyboardIcon, RotateCcwIcon, SearchIcon, XIcon } from "lucide-react"
import { isImeKeydown, parseCombo, tokenOfCode } from "@filen/shared/keymap"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { CARD_SURFACE_CLASS } from "@/components/ui/surface"
import { ChordKeys } from "@/lib/keymap/kbd"
import { reservedMessage, spokenChord } from "@/lib/keymap/keyText"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { useKeyboardLayout } from "@/lib/keymap/layout"
import { useShortcutCatalog } from "@/lib/keymap/actions"
import { normalizeRecordedCombo, recordingOutcome } from "@/lib/keymap/captureCombo"
import { commitRecordedChord } from "@/lib/keymap/recording"
import { filterCounts, searchShortcuts, SHORTCUT_NAMESPACES, type ShortcutFilter, type ShortcutGroup } from "@/lib/keymap/shortcutsCatalog"
import {
	beginRecording,
	clearRecording,
	endRecording,
	resetOverrides,
	setCharacterKeys,
	useCharacterKeys,
	useRecordingProblem,
	useRecordingSession,
	type ResolvedAction
} from "@/lib/keymap/registry"
import { ShortcutRow } from "@/lib/keymap/shortcutRow"
import { ShortcutsRows, type VirtualRow } from "@/lib/keymap/shortcutsRows"
import { SpecialKeyDialog } from "@/lib/keymap/specialKeyDialog"
import { useAction } from "@/lib/keymap/useAction"
import { ignoredOutsideLayer, LAYER_FIELD_TAGS } from "@/features/settings/lib/layerKeys"

const IS_MAC = isMacPlatform()

// Module-level so the array identity is stable across renders — useRecordHotkeys memoizes its blacklist on that
// reference. Tab is a near-certain accidental capture while a row's button has focus; a blacklisted key is skipped
// AND not preventDefault-ed, so Tab keeps moving focus. Escape is the cancel key, handled at capture on this
// component's root and recognized by recordingOutcome when it arrives through the recorder instead. Both can still be
// bound through the special keys picker.
const RECORDER_BLACKLIST = ["tab"]

const MODIFIER_TOKENS: ReadonlySet<string> = new Set(["shift", "alt", "ctrl", "meta"])

const FILTERS: readonly ShortcutFilter[] = ["all", "changed", "conflicts", "unset"]

type ListRow =
	(VirtualRow & { kind: "group"; group: ShortcutGroup; folded: boolean }) | (VirtualRow & { kind: "action"; action: ResolvedAction })

// The one shortcuts list in the app, rendered by BOTH surfaces (Settings → Keyboard, and the `?` dialog as the compact
// variant) so neither can drift from the other or from the registry: search by name or by pressed keys, filters,
// collapsible groups, and per action its key combinations, each removable, plus new ones recorded or picked.
//
// Recording is an app-wide session owned by the keymap store, not local state: the recorder and react-hotkeys-hook's
// matcher both listen on `document` and the matcher's listeners are registered first, so a recording can only be
// made safe by suppressing every action for its duration (useAction.ts). The `useId()` token keeps that correct when
// two lists are mounted at once — the dialog can open on top of this page.
// `initialText` starts the list searched (a player opens it on its own group).
export function ShortcutsList({ variant, initialText }: { variant: "page" | "dialog"; initialText?: string }) {
	const { t } = useTranslation([...SHORTCUT_NAMESPACES])
	const { t: settingsT } = useTranslation("settings")
	const owner = useId()
	const catalog = useShortcutCatalog()
	const characterKeys = useCharacterKeys()
	const session = useRecordingSession()
	const problem = useRecordingProblem()
	const layout = useKeyboardLayout()
	const [keys, { start, stop, isRecording }] = useRecordHotkeys(false, RECORDER_BLACKLIST)
	const [text, setText] = useState(initialText ?? "")
	const [keyQuery, setKeyQuery] = useState<string | null>(null)
	const [filter, setFilter] = useState<ShortcutFilter>("all")
	const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
	const [specialFor, setSpecialFor] = useState<string | null>(null)
	const searchRef = useRef<HTMLInputElement>(null)
	const rootRef = useRef<HTMLDivElement>(null)
	const compact = variant === "dialog"

	// Def in features/settings/lib/keymap.ts: the list's own search, in whichever layer it is shown (the page, or the
	// `?` dialog over it), and from the search box itself, where Mod+F would otherwise open the browser's find.
	useAction(
		"settings.search",
		event => {
			event.preventDefault()
			searchRef.current?.focus()
			searchRef.current?.select()
		},
		{ ignoreEventWhen: event => ignoredOutsideLayer(event, rootRef.current), enableOnFormTags: LAYER_FIELD_TAGS }
	)

	// The session is the only source of truth for what records here: one claimed by another list reads as "not
	// recording here".
	const mine = session?.owner === owner ? session : null
	const searchingKeys = mine !== null && mine.actionId === null
	const recordingAction = mine?.actionId ?? null
	const recordingKey = recordingAction === null ? null : `${recordingAction}:${String(mine?.slot ?? "add")}`
	// The recorder's key set outlives the session that filled it, so what it MEANS is decided in one place
	// (recordingOutcome) and read back as primitives — the commit effect's deps stay free of per-render identities.
	const outcome = recordingAction === null ? null : recordingOutcome(keys, isRecording, IS_MAC)
	const recorded = outcome?.kind === "commit" ? outcome.combo : null
	const cancelled = outcome?.kind === "cancel"

	// A freshly mounted list cancels whatever recording was in flight (and any problem from an earlier attempt), so
	// opening the dialog over a recording settings page ends that recording instead of letting it capture the dialog's
	// keys. On unmount it ends only its own.
	useEffect(() => {
		clearRecording()

		return () => {
			endRecording(owner)
		}
	}, [owner])

	// The recorder follows the store's session, never the click that started it — when another list claims the
	// session this one has to stop even though nothing here was interacted with. The key search records in its own
	// field instead.
	useEffect(() => {
		if (recordingKey === null) {
			stop()

			return
		}

		start()
	}, [recordingKey, start, stop])

	// Commit as soon as a full chord lands.
	useEffect(() => {
		if (recordingKey === null) {
			return
		}

		if (cancelled) {
			endRecording(owner)

			return
		}

		if (recorded !== null) {
			void commitRecordedChord(owner, recorded)
		}
	}, [recorded, cancelled, recordingKey, owner])

	// Escape cancels the recording instead of dismissing the surface around us. Capture phase on our own root runs
	// before the focused button, React's bubble dispatch (Base UI's dismiss) and the document listeners (Base UI's
	// escape dismiss, and react-hotkeys-hook's). A press with focus elsewhere reaches the recorder's own document
	// listener instead, which is why recordingOutcome treats a recorded escape as cancel too.
	function handleKeyDownCapture(event: KeyboardEvent) {
		if (mine === null || event.key !== "Escape") {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		endRecording(owner)
	}

	// The key search records the chord pressed in its own field, through the token model every matcher reads.
	function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (!searchingKeys || event.key === "Tab" || isImeKeydown(event.nativeEvent)) {
			return
		}

		event.preventDefault()

		const token = tokenOfCode(event.code)

		if (MODIFIER_TOKENS.has(token)) {
			return
		}

		const pressed = [
			...(event.metaKey ? ["meta"] : []),
			...(event.ctrlKey ? ["ctrl"] : []),
			...(event.altKey ? ["alt"] : []),
			...(event.shiftKey ? ["shift"] : []),
			token
		]

		setKeyQuery(normalizeRecordedCombo(pressed, IS_MAC))
		endRecording(owner)
	}

	const nameOf = (id: string): string => {
		const action = catalog.byId.get(id)

		return action === undefined ? id : t(action.descriptionKey)
	}
	const groupLabel = (group: ShortcutGroup): string =>
		group.sectionLabelKey === null ? t(group.labelKey) : `${t(group.labelKey)} › ${t(`settings:${group.sectionLabelKey}`)}`

	const query = { text: text.trim().toLocaleLowerCase(), keys: keyQuery, filter }
	const narrowed = query.text !== "" || query.keys !== null || filter !== "all"
	const groups = searchShortcuts(
		catalog.groups,
		query,
		catalog.conflicts,
		action => `${t(action.descriptionKey)} ${action.hintKey === undefined ? "" : t(action.hintKey)}`.toLocaleLowerCase(),
		group => groupLabel(group).toLocaleLowerCase(),
		IS_MAC
	)
	const counts = filterCounts(catalog.actions, catalog.conflicts)
	const rows: ListRow[] = []

	for (const group of groups) {
		const isFolded = !narrowed && folded.has(group.key)

		rows.push({ key: `group:${group.key}`, kind: "group", group, folded: isFolded })

		if (!isFolded) {
			for (const action of group.actions) rows.push({ key: action.id, kind: "action", action })
		}
	}

	const toggleFolded = (key: string): void => {
		const next = new Set(folded)

		if (next.has(key)) {
			next.delete(key)
		} else {
			next.add(key)
		}

		setFolded(next)
	}

	const recordingName = recordingAction === null ? null : nameOf(recordingAction)
	const problemName = problem === null ? null : nameOf(problem.actionId)
	const [problemChord] = problem === null ? [] : parseCombo(problem.chord)
	const problemKeys = problemChord === undefined ? "" : spokenChord(problemChord, key => settingsT(key), layout)
	// Read out by screen readers: the recording prompt, then why a recording was not simply saved.
	const announcement =
		recordingName !== null && isRecording
			? t("settings:keyboardRecordingAnnounce", { action: recordingName })
			: problem === null || problemName === null
				? ""
				: problem.kind === "conflict"
					? t("settings:keyboardConflictWith", { keys: problemKeys, actions: problem.conflictIds.map(nameOf).join(", ") })
					: reservedMessage(settingsT, problem.owner, problemKeys)
	const [keyQueryChord] = keyQuery === null ? [] : parseCombo(keyQuery)
	const specialAction = specialFor === null ? undefined : catalog.byId.get(specialFor)

	const renderRow = (row: ListRow) => {
		if (row.kind === "group") {
			const label = groupLabel(row.group)
			const changed = row.group.actions.filter(action => action.overridden).map(action => action.id)

			return (
				<div className="flex items-center gap-1 px-1 pt-3 pb-1">
					<h3 className="min-w-0 flex-1">
						<button
							type="button"
							className="flex w-full min-w-0 items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-medium text-muted-foreground focus-ring outline-none hover:text-foreground"
							aria-expanded={!row.folded}
							disabled={narrowed}
							onClick={() => {
								toggleFolded(row.group.key)
							}}
						>
							{row.folded ? (
								<ChevronRightIcon
									aria-hidden="true"
									className="size-3.5 shrink-0"
								/>
							) : (
								<ChevronDownIcon
									aria-hidden="true"
									className="size-3.5 shrink-0"
								/>
							)}
							<span className="truncate">{label}</span>
						</button>
					</h3>
					{changed.length > 0 && (
						<Button
							variant="ghost"
							size="xs"
							aria-label={t("settings:keyboardResetGroup", { group: label })}
							onClick={() => {
								void resetOverrides(changed)
							}}
						>
							<RotateCcwIcon data-icon="inline-start" />
							{t("common:shortcutsResetToDefault")}
						</Button>
					)}
				</div>
			)
		}

		const { action } = row
		const own = recordingAction === action.id ? (mine?.slot ?? null) : undefined

		return (
			<ShortcutRow
				action={action}
				recordingSlot={own}
				armed={own !== undefined && isRecording}
				problem={problem?.actionId === action.id ? problem : null}
				conflicts={catalog.conflicts.get(action.id)}
				characterKeys={characterKeys}
				layout={layout}
				compact={compact}
				nameOf={nameOf}
				onRecord={slot => {
					beginRecording(owner, action.id, slot)
				}}
				onCancel={() => {
					endRecording(owner)
				}}
				onSpecial={() => {
					setSpecialFor(action.id)
				}}
			/>
		)
	}

	return (
		<div
			ref={rootRef}
			className="flex min-h-0 flex-1 flex-col gap-3"
			onKeyDownCapture={handleKeyDownCapture}
		>
			<div className="flex flex-col gap-2">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<div
						className={cn(
							"relative flex min-w-0 flex-1 basis-60 items-center",
							searchingKeys && "rounded-lg ring-2 ring-primary/60"
						)}
					>
						<SearchIcon
							aria-hidden="true"
							className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground"
						/>
						<Input
							ref={searchRef}
							type="search"
							value={searchingKeys ? "" : text}
							placeholder={searchingKeys ? t("settings:keyboardSearchRecording") : t("settings:keyboardSearchPlaceholder")}
							aria-label={t("settings:keyboardSearchLabel")}
							className={cn("pl-8", keyQueryChord === undefined ? "pr-9" : "pr-28")}
							onChange={event => {
								setText(event.target.value)
							}}
							onKeyDown={handleSearchKeyDown}
							onBlur={() => {
								if (searchingKeys) {
									endRecording(owner)
								}
							}}
						/>
						<div className="absolute right-1 flex items-center gap-1">
							{keyQueryChord !== undefined && (
								<span className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1">
									<ChordKeys
										chord={keyQueryChord}
										layout={layout}
									/>
									<button
										type="button"
										className="inline-flex size-5 items-center justify-center rounded text-muted-foreground focus-ring outline-none hover:text-foreground"
										aria-label={t("settings:keyboardSearchClearKeys")}
										onClick={() => {
											setKeyQuery(null)
										}}
									>
										<XIcon
											aria-hidden="true"
											className="size-3"
										/>
									</button>
								</span>
							)}
							<Button
								variant={searchingKeys ? "secondary" : "ghost"}
								size="icon-xs"
								aria-label={t("settings:keyboardSearchByKeys")}
								aria-pressed={searchingKeys}
								onMouseDown={event => {
									// Keeps focus in the field, which records the keys.
									event.preventDefault()
								}}
								onClick={() => {
									if (searchingKeys) {
										endRecording(owner)

										return
									}

									beginRecording(owner, null)
									searchRef.current?.focus()
								}}
							>
								<KeyboardIcon />
							</Button>
						</div>
					</div>
					{!compact && (
						<label className="flex shrink-0 items-center gap-2 text-sm">
							<span title={t("settings:keyboardCharacterKeysDescription")}>{t("settings:keyboardCharacterKeys")}</span>
							<Switch
								checked={characterKeys}
								aria-describedby={`${owner}-character-keys`}
								onCheckedChange={checked => {
									void setCharacterKeys(checked)
								}}
							/>
							<span
								id={`${owner}-character-keys`}
								className="sr-only"
							>
								{t("settings:keyboardCharacterKeysDescription")}
							</span>
						</label>
					)}
				</div>
				<div
					role="group"
					aria-label={t("settings:keyboardFilters")}
					className="flex flex-wrap gap-1"
				>
					{FILTERS.map(option => (
						<Button
							key={option}
							variant={filter === option ? "secondary" : "ghost"}
							size="xs"
							aria-pressed={filter === option}
							onClick={() => {
								setFilter(option)
							}}
						>
							{option === "all"
								? t("settings:keyboardFilterAll")
								: option === "changed"
									? t("settings:keyboardFilterChanged", { count: counts.changed })
									: option === "conflicts"
										? t("settings:keyboardFilterConflicts", { count: counts.conflicts })
										: t("settings:keyboardFilterUnset", { count: counts.unset })}
						</Button>
					))}
				</div>
			</div>
			<p
				aria-live="polite"
				className="sr-only"
			>
				{announcement}
			</p>
			{rows.length === 0 ? (
				<p className="px-2 py-6 text-center text-sm text-muted-foreground">{t("settings:keyboardNoMatches")}</p>
			) : (
				<div className={cn("flex min-h-0 flex-1 flex-col", !compact && CARD_SURFACE_CLASS)}>
					<ShortcutsRows
						rows={rows}
						label={t("common:shortcutsTitle")}
						className="flex-1 px-1 pb-2"
						renderRow={renderRow}
					/>
				</div>
			)}
			{specialAction !== undefined && (
				<SpecialKeyDialog
					actionName={t(specialAction.descriptionKey)}
					open
					onOpenChange={open => {
						if (!open) {
							setSpecialFor(null)
						}
					}}
					onAdd={chord => {
						setSpecialFor(null)
						beginRecording(owner, specialAction.id, null)
						void commitRecordedChord(owner, chord)
					}}
				/>
			)}
		</div>
	)
}
