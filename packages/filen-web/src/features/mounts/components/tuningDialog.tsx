import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { type } from "arktype"
import type { DesktopVfsTuning } from "@filen/shared/desktop"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { mountsApi } from "@/features/mounts/lib/mountsStore"
import { runMountsAction } from "@/features/mounts/lib/mountsActions"
import { tuningInput } from "@/features/mounts/lib/mountsStatus.logic"
import type { MountsKey } from "@/lib/i18n"

type TuningField = keyof DesktopVfsTuning

const FIELDS: readonly { field: TuningField; label: MountsKey; range: MountsKey }[] = [
	{ field: "cacheMaxGiB", label: "tuningCacheMax", range: "tuningCacheMaxRange" },
	{ field: "cacheMinFreeGiB", label: "tuningMinFree", range: "tuningMinFreeRange" },
	{ field: "cacheMaxAgeHours", label: "tuningMaxAge", range: "tuningMaxAgeRange" },
	{ field: "dirCacheSeconds", label: "tuningDirCache", range: "tuningDirCacheRange" }
]

function draftOf(tuning: DesktopVfsTuning): Record<TuningField, string> {
	return {
		cacheMaxGiB: String(tuning.cacheMaxGiB),
		cacheMinFreeGiB: String(tuning.cacheMinFreeGiB),
		cacheMaxAgeHours: String(tuning.cacheMaxAgeHours),
		dirCacheSeconds: String(tuning.dirCacheSeconds)
	}
}

// The cache every mount and server shares. Saving restarts the running ones, so it is sent only when something changed.
export function TuningDialog({ tuning, onClose }: { tuning: DesktopVfsTuning; onClose: () => void }) {
	const { t } = useTranslation(["mounts", "common"])
	const id = useId()
	const [draft, setDraft] = useState(() => draftOf(tuning))
	const [pending, setPending] = useState(false)
	const parsed = tuningInput(draft)
	const invalid = parsed instanceof type.errors ? new Set(parsed.map(error => String(error.path[0]))) : null
	const changed = !(parsed instanceof type.errors) && FIELDS.some(({ field }) => parsed[field] !== tuning[field])

	async function save(next: DesktopVfsTuning): Promise<void> {
		setPending(true)

		const done = await runMountsAction(() => mountsApi().setTuning(next))

		setPending(false)

		if (done !== null) {
			onClose()
		}
	}

	return (
		<FormDialog
			open
			pending={pending}
			title={t("tuningTitle")}
			description={t("tuningDescription")}
			submitLabel={t("tuningSave")}
			cancelLabel={t("common:cancel")}
			canSubmit={changed}
			onOpenChange={next => {
				if (!next) {
					onClose()
				}
			}}
			onSubmit={event => {
				event.preventDefault()

				if (!(parsed instanceof type.errors) && changed) {
					void save(parsed)
				}
			}}
		>
			<FieldGroup>
				{FIELDS.map(({ field, label, range }) => {
					const fieldId = `${id}-${field}`
					const fieldInvalid = invalid?.has(field) === true

					return (
						<Field key={field}>
							<FieldLabel htmlFor={fieldId}>{t(label)}</FieldLabel>
							<Input
								id={fieldId}
								inputMode="numeric"
								className="leading-5"
								value={draft[field]}
								disabled={pending}
								aria-invalid={fieldInvalid}
								aria-describedby={`${fieldId}-hint`}
								onChange={event => {
									setDraft({ ...draft, [field]: event.target.value })
								}}
							/>
							{fieldInvalid ? (
								<FieldError id={`${fieldId}-hint`}>{t(range)}</FieldError>
							) : (
								<FieldDescription id={`${fieldId}-hint`}>{t(range)}</FieldDescription>
							)}
						</Field>
					)
				})}
			</FieldGroup>
		</FormDialog>
	)
}
