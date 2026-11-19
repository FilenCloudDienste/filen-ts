import { useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { DesktopSyncUserIgnore } from "@filen/shared/desktop"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FIELD_CONTROL_CLASS } from "@/components/ui/surface"
import { log } from "@/lib/log"
import { SettingsBlock, SettingsGroup } from "@/features/settings/components/settingsLayout"
import { useSyncRead } from "@/features/sync/hooks/useSyncRead"
import { syncApi } from "@/features/sync/lib/syncStore"
import { syncErrorLabel } from "@/features/sync/lib/syncActions"
import { IN_EDITORS_AND_FIELDS, useAction } from "@/lib/keymap/useAction"
import { SyncReadError } from "@/features/sync/components/syncEntryRows"

// One box metric for the textarea and the backdrop behind it, so the highlighted line sits exactly under its text.
const EDITOR_TEXT_CLASS = "px-3 py-2 font-mono text-sm leading-5 whitespace-pre"

// The unsaved edit, held above the editor: a tab or pair switch unmounts it, and the rules are device-wide, so one
// draft serves every pair. Module memory only, so sign-out's reload drops it.
let draft: string | null = null

// The editor over the rules as read. Its text is frozen at mount: a later read never overwrites what the user is
// typing. A save moves the baseline to the saved text in place (the shell stores it verbatim), keeping the editor
// mounted with its focus, caret and scroll.
function RulesEditor({ initialText }: { initialText: string }) {
	const { t } = useTranslation("sync")
	const id = useId()
	const [baseline, setBaseline] = useState(initialText)
	const [text, setText] = useState(() => draft ?? initialText)
	const [invalidLine, setInvalidLine] = useState<number | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const backdropRef = useRef<HTMLDivElement>(null)
	const lines = text.split("\n")

	async function save(): Promise<void> {
		setSaving(true)
		setError(null)

		// The text box is read-only while saving, so what was sent is what it still shows.
		const saved = text

		try {
			const result = await syncApi().setUserIgnore(saved)

			if (result.ok) {
				draft = null
				setBaseline(saved)
				toast.success(t("userIgnoreSaved"))
			} else if (result.error.code === "invalidIgnore" && result.error.line !== undefined) {
				setInvalidLine(result.error.line)
				setError(t("userIgnoreInvalidLine", { line: result.error.line }))
			} else {
				setError(syncErrorLabel(result.error))
			}
		} catch (cause) {
			log.warn("sync", "ignore rules could not be saved", cause)
			setError(t("errorUnknown"))
		} finally {
			setSaving(false)
		}
	}

	const unchanged = text === baseline

	// Def in features/sync/lib/keymap.ts: Mod+S saves while focus is in this editor (its text box included, where the
	// browser would otherwise save the page), under the Save button's own gate.
	const saveKeyRef = useAction(
		"sync.saveIgnoreRules",
		event => {
			event.preventDefault()

			if (!saving && !unchanged) {
				void save()
			}
		},
		IN_EDITORS_AND_FIELDS,
		[saving, unchanged, text]
	)

	return (
		<SettingsBlock
			ref={saveKeyRef}
			className="flex flex-col gap-3"
		>
			<div className={cn("relative h-48 overflow-hidden", FIELD_CONTROL_CLASS, error !== null && "border-destructive")}>
				<div
					ref={backdropRef}
					aria-hidden="true"
					className={cn("pointer-events-none absolute inset-0 overflow-hidden text-transparent", EDITOR_TEXT_CLASS)}
				>
					{lines.map((line, index) => (
						<div
							key={index}
							className={cn(index + 1 === invalidLine && "-mx-1 rounded-sm bg-destructive/20 px-1")}
						>
							{line.length === 0 ? " " : line}
						</div>
					))}
				</div>
				<textarea
					id={id}
					value={text}
					spellCheck={false}
					wrap="off"
					aria-label={t("userIgnoreTitle")}
					aria-invalid={invalidLine !== null}
					aria-describedby={error === null ? undefined : `${id}-error`}
					// Read-only rather than disabled, which would drop the focus.
					readOnly={saving}
					aria-busy={saving}
					className={cn("absolute inset-0 resize-none overflow-auto bg-transparent outline-none", EDITOR_TEXT_CLASS)}
					onScroll={event => {
						const backdrop = backdropRef.current

						if (backdrop !== null) {
							backdrop.scrollTop = event.currentTarget.scrollTop
							backdrop.scrollLeft = event.currentTarget.scrollLeft
						}
					}}
					onChange={event => {
						const value = event.target.value

						setText(value)
						draft = value === baseline ? null : value
						setInvalidLine(null)
						setError(null)
					}}
				/>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2">
				{error === null ? (
					<span />
				) : (
					<p
						id={`${id}-error`}
						role="alert"
						className="text-sm text-destructive"
					>
						{error}
					</p>
				)}
				<Button
					disabled={saving || unchanged}
					onClick={() => {
						void save()
					}}
				>
					{saving ? <Spinner data-icon="inline-start" /> : null}
					{t("userIgnoreSave")}
				</Button>
			</div>
		</SettingsBlock>
	)
}

function Defaults({ defaults }: { defaults: readonly string[] }) {
	const { t } = useTranslation("sync")

	if (defaults.length === 0) {
		return null
	}

	return (
		<SettingsBlock className="flex flex-col gap-2">
			<p className="text-sm font-medium">{t("userIgnoreDefaults")}</p>
			<pre className="max-h-40 overflow-auto rounded-xl bg-muted px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">
				{defaults.join("\n")}
			</pre>
		</SettingsBlock>
	)
}

// The device-wide ignore rules the user writes, over the engine's built-in ones (read-only). One set for every
// pair: the shell applies it to each.
export function UserIgnoreEditor() {
	const { t } = useTranslation("sync")
	// Read once per mount: a save keeps the editor and its text instead of reading back what it just wrote.
	const read = useSyncRead<DesktopSyncUserIgnore>("userIgnore", () => syncApi().userIgnore())

	return (
		<SettingsGroup
			title={t("userIgnoreTitle")}
			description={t("userIgnoreDescription")}
		>
			{read.data === undefined ? (
				read.error === null ? (
					<SettingsBlock className="flex justify-center">
						<Spinner className="size-5 text-muted-foreground" />
					</SettingsBlock>
				) : (
					<SyncReadError
						error={read.error}
						onRetry={read.reload}
					/>
				)
			) : (
				<RulesEditor initialText={read.data.text} />
			)}
			{read.data === undefined ? null : <Defaults defaults={read.data.defaults} />}
		</SettingsGroup>
	)
}
