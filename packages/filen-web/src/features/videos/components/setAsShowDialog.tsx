import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { log } from "@/lib/log"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import { editLibraryConfig, useVideoTitleDetailQuery } from "@/features/videos/queries/library"
import { useCatalogSeriesQuery } from "@/features/videos/queries/catalog"
import { NEW_SERIES } from "@/features/videos/lib/corrections.logic"
import { episodeCode } from "@/features/videos/lib/videoCard.logic"
import {
	guessSeriesName,
	planEpisodes,
	setShowEdit,
	showDestination,
	type EpisodeNumber,
	type SetAsSource,
	type ShowTarget
} from "@/features/videos/lib/setAs.logic"
import { OptionSelect } from "@/features/videos/components/detail/correctionsDialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

const NO_NUMBERS: readonly EpisodeNumber[] = []

function sameName(a: string, b: string): boolean {
	return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()
}

// Set as › Show…: asks once for the show (an existing one, or a new one by name, prefilled from the file names) and
// shows how each title will be numbered before saving them all in one write.
export function SetAsShowDialog({
	sources,
	onClose,
	onSaved
}: {
	sources: readonly SetAsSource[]
	onClose: () => void
	// The series the episodes are shown in now, null when there is none.
	onSaved: (seriesId: string | null) => void
}) {
	const { t } = useTranslation(["videos", "common"])
	const isOnline = useIsOnline()
	const ids = { series: useId(), name: useId(), form: useId() }
	const seriesList = useCatalogSeriesQuery(true).data
	const [guess] = useState(() => guessSeriesName(sources))
	const [picked, setPicked] = useState<string | null>(null)
	const [name, setName] = useState(guess)
	const [pending, setPending] = useState(false)
	// An existing show of the guessed name is the default; until the list is known, a new one.
	const matching = seriesList?.find(item => sameName(item.title, guess))
	const series = picked ?? (matching === undefined ? NEW_SERIES : `d:${matching.id}`)
	const existingId = series === NEW_SERIES ? "" : series.slice(2)
	const existing = useVideoTitleDetailQuery(existingId, existingId.length > 0).data
	const taken = existing?.kind === "series" ? existing.seasons.flatMap(season => season.episodes) : NO_NUMBERS
	const plan = planEpisodes({ sources, taken })
	const target: ShowTarget = series === NEW_SERIES ? { kind: "new", name } : { kind: "existing", key: series }
	const options = [
		{ value: NEW_SERIES, label: t("detailNewSeries", { title: name.trim().length > 0 ? name.trim() : guess }) },
		...(seriesList ?? []).map(item => ({ value: `d:${item.id}`, label: item.title }))
	]
	const invalid = target.kind === "new" && name.trim().length === 0

	function save(): void {
		if (invalid || pending) {
			return
		}

		setPending(true)

		// Promise handlers rather than try/finally, which the React Compiler can't compile yet.
		void editLibraryConfig(setShowEdit({ plan, target })).then(
			() => {
				setPending(false)
				onClose()
				onSaved(showDestination({ plan, target }))
			},
			(e: unknown) => {
				log.warn("videos.setAs", "setting titles as episodes failed", e)
				toast.error(errorLabel(e))
				setPending(false)
			}
		)
	}

	return (
		<Dialog
			open
			onOpenChange={open => {
				if (!open) {
					onClose()
				}
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("setAsShowTitle")}</DialogTitle>
					<DialogDescription>{t("setAsShowDescription")}</DialogDescription>
				</DialogHeader>
				<form
					id={ids.form}
					className="flex min-h-0 flex-col gap-5"
					onSubmit={event => {
						event.preventDefault()
						save()
					}}
				>
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor={ids.series}>{t("detailFieldSeries")}</FieldLabel>
							<OptionSelect
								id={ids.series}
								options={options}
								value={series}
								onChange={setPicked}
							/>
						</Field>
						{target.kind === "new" ? (
							<Field>
								<FieldLabel htmlFor={ids.name}>{t("setAsShowName")}</FieldLabel>
								<Input
									id={ids.name}
									value={name}
									maxLength={256}
									aria-invalid={invalid}
									onChange={event => {
										setName(event.target.value)
									}}
								/>
							</Field>
						) : null}
					</FieldGroup>
					<section aria-label={t("setAsShowPreview")}>
						<p className="mb-2 text-sm font-medium">{t("setAsShowPreview")}</p>
						<ul className="max-h-56 overflow-y-auto rounded-md border text-sm">
							{plan.map(entry => (
								<li
									key={entry.source.subject.key}
									className="flex items-baseline gap-3 border-b px-3 py-1.5 last:border-b-0"
								>
									<span className="shrink-0 font-medium tabular-nums">
										{episodeCode({ season: entry.season, episode: entry.episode, episodeEnd: entry.episodeEnd })}
									</span>
									<span className="min-w-0 flex-1 truncate text-muted-foreground">
										{entry.source.fileName.length > 0 ? entry.source.fileName : entry.source.title}
									</span>
									{entry.derived ? null : (
										<span className="shrink-0 text-xs text-muted-foreground">{t("setAsShowNumbered")}</span>
									)}
								</li>
							))}
						</ul>
					</section>
				</form>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={onClose}
					>
						{t("common:cancel")}
					</Button>
					<Button
						type="submit"
						form={ids.form}
						disabled={invalid || pending || !isOnline || plan.length === 0}
					>
						{pending ? <Spinner data-icon="inline-start" /> : null}
						{t("setAsShowSave")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
