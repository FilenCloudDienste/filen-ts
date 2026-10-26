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

// One box metric for the textarea and the backdrop behind it, so the highlighted line sits exactly under its text.
const EDITOR_TEXT_CLASS = "px-3 py-2 font-mono text-sm leading-5 whitespace-pre"

// The editor over the rules as read. Its text is frozen at mount: a later read never overwrites what the user is
// typing (the parent remounts it after a save).
function RulesEditor({ initialText, onSaved }: { initialText: string; onSaved: () => void }) {
	const { t } = useTranslation("sync")
	const id = useId()
	const [text, setText] = useState(initialText)
	const [invalidLine, setInvalidLine] = useState<number | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const backdropRef = useRef<HTMLDivElement>(null)
	const lines = text.split("\n")

	async function save(): Promise<void> {
		setSaving(true)
		setError(null)

		try {
			const result = await syncApi().setUserIgnore(text)

			if (result.ok) {
				toast.success(t("userIgnoreSaved"))
				onSaved()
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

	return (
		<SettingsBlock className="flex flex-col gap-3">
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
					disabled={saving}
					className={cn("absolute inset-0 resize-none overflow-auto bg-transparent outline-none", EDITOR_TEXT_CLASS)}
					onScroll={event => {
						const backdrop = backdropRef.current

						if (backdrop !== null) {
							backdrop.scrollTop = event.currentTarget.scrollTop
							backdrop.scrollLeft = event.currentTarget.scrollLeft
						}
					}}
					onChange={event => {
						setText(event.target.value)
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
					disabled={saving || text === initialText}
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
	const [generation, setGeneration] = useState(0)
	const read = useSyncRead<DesktopSyncUserIgnore>(`userIgnore:${String(generation)}`, () => syncApi().userIgnore())

	return (
		<SettingsGroup
			title={t("userIgnoreTitle")}
			description={t("userIgnoreDescription")}
		>
			{read.data === undefined ? (
				<SettingsBlock className="flex justify-center">
					{read.error === null ? (
						<Spinner className="size-5 text-muted-foreground" />
					) : (
						<p
							role="alert"
							className="text-sm text-destructive"
						>
							{syncErrorLabel(read.error)}
						</p>
					)}
				</SettingsBlock>
			) : (
				<RulesEditor
					key={read.data.text}
					initialText={read.data.text}
					onSaved={() => {
						setGeneration(previous => previous + 1)
					}}
				/>
			)}
			{read.data === undefined ? null : <Defaults defaults={read.data.defaults} />}
		</SettingsGroup>
	)
}
