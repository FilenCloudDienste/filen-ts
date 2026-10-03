import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useArchivePreferencesQuery } from "@/features/settings/queries/preferences"
import {
	setArchivePreferences,
	ARCHIVE_CODEC_MEMORY_MIB,
	DEFAULT_ARCHIVE_PREFERENCES,
	type ArchivePreferences
} from "@/features/settings/lib/archiveConfig"
import { archiveCodecMemBudget } from "@/features/drive/lib/archiveHelpers"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"

const MIB = 1024 * 1024

// The budget the running client was built with, read once per page; undefined until it answers or
// when it can't.
function useInEffectMib(): number | undefined {
	const [mib, setMib] = useState<number | undefined>(undefined)

	useEffect(() => {
		let live = true

		archiveCodecMemBudget().then(
			bytes => {
				if (live) {
					setMib(Math.round(bytes / MIB))
				}
			},
			() => undefined
		)

		return () => {
			live = false
		}
	}, [])

	return mib
}

// Advanced → archive codec memory. Like the transfer preset, the client reads it only when built, so
// a change applies at the next load; until then the row names the value still in effect.
function ArchiveMemoryRow() {
	const { t } = useTranslation("settings")
	const query = useArchivePreferencesQuery()
	const prefs = query.data
	const inEffectMib = useInEffectMib()

	async function apply(next: ArchivePreferences): Promise<void> {
		await setArchivePreferences(next)
		void query.refetch()
		toast.info(t("settingsAdvancedRestartRequired"))
	}

	const description: string[] = [
		t("settingsAdvancedArchiveMemoryDescription"),
		t("settingsAdvancedArchiveMemoryHighHint", { size: Math.max(...ARCHIVE_CODEC_MEMORY_MIB) }),
		t("settingsAdvancedRestartRequired")
	]

	if (prefs !== undefined && inEffectMib !== undefined && inEffectMib !== prefs.codecMemoryMib) {
		description.push(t("settingsAdvancedArchiveMemoryInEffect", { size: inEffectMib }))
	}

	return (
		<SettingsSelectRow
			label={t("settingsAdvancedArchiveMemory")}
			description={description.join(" ")}
			id="advanced-archive-memory"
			options={ARCHIVE_CODEC_MEMORY_MIB.map(size => ({
				value: String(size),
				label:
					size === DEFAULT_ARCHIVE_PREFERENCES.codecMemoryMib
						? t("settingsAdvancedArchiveMemoryOptionDefault", { size })
						: t("settingsAdvancedArchiveMemoryOption", { size })
			}))}
			value={prefs === undefined ? undefined : String(prefs.codecMemoryMib)}
			disabled={query.isFetching}
			onChange={value => {
				const size = ARCHIVE_CODEC_MEMORY_MIB.find(option => String(option) === value)

				// The select only renders once prefs loaded.
				if (prefs !== undefined && size !== undefined) {
					void apply({ ...prefs, codecMemoryMib: size })
				}
			}}
		/>
	)
}

export { ArchiveMemoryRow }
