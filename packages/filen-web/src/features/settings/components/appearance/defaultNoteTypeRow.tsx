import type { NoteType } from "@filen/sdk-rs"
import { useTranslation } from "react-i18next"
import { NOTE_TYPES, setDefaultNoteType } from "@/features/notes/lib/preferences"
import { useDefaultNoteTypeQuery } from "@/features/notes/queries/preferences"
import { saveSetting } from "@/features/settings/components/appearance/saveSetting"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"
import type { NotesKey } from "@/lib/i18n"

const NOTE_TYPE_LABEL_KEYS: Record<NoteType, NotesKey> = {
	text: "noteTypeText",
	rich: "noteTypeRich",
	checklist: "noteTypeChecklist",
	md: "noteTypeMd",
	code: "noteTypeCode"
}

// The type createNote gives a new note; same query it reads, so a create right after a change uses the new value.
function DefaultNoteTypeRow() {
	const { t } = useTranslation(["settings", "notes"])
	const query = useDefaultNoteTypeQuery()

	async function apply(next: NoteType): Promise<void> {
		if (await saveSetting(() => setDefaultNoteType(next))) {
			void query.refetch()
		}
	}

	return (
		<SettingsSelectRow
			label={t("settingsDefaultNoteTypeTitle")}
			description={t("settingsDefaultNoteTypeDescription")}
			id="default-note-type-select"
			options={NOTE_TYPES.map(noteType => ({ value: noteType, label: t(`notes:${NOTE_TYPE_LABEL_KEYS[noteType]}`) }))}
			value={query.data}
			disabled={query.data === undefined}
			onChange={value => void apply(value)}
		/>
	)
}

export { DefaultNoteTypeRow }
