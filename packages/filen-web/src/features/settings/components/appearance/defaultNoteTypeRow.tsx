import type { NoteType } from "@filen/sdk-rs"
import { useTranslation } from "react-i18next"
import { NOTE_TYPES, setDefaultNoteType, useDefaultNoteType } from "@/features/notes/lib/preferences"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"
import type { NotesKey } from "@/lib/i18n"

const NOTE_TYPE_LABEL_KEYS: Record<NoteType, NotesKey> = {
	text: "noteTypeText",
	rich: "noteTypeRich",
	checklist: "noteTypeChecklist",
	md: "noteTypeMd",
	code: "noteTypeCode"
}

// The type createNote gives a new note; the same held value it reads, so a create right after a change uses the new
// value.
function DefaultNoteTypeRow() {
	const { t } = useTranslation(["settings", "notes"])
	const value = useDefaultNoteType()

	return (
		<SettingsSelectRow
			label={t("settingsDefaultNoteTypeTitle")}
			helpId="defaultNoteType"
			description={t("settingsDefaultNoteTypeDescription")}
			id="default-note-type-select"
			options={NOTE_TYPES.map(noteType => ({ value: noteType, label: t(`notes:${NOTE_TYPE_LABEL_KEYS[noteType]}`) }))}
			value={value}
			disabled={false}
			onChange={setDefaultNoteType}
		/>
	)
}

export { DefaultNoteTypeRow }
