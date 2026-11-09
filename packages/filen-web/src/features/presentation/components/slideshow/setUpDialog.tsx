import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import type { CustomShow } from "@filen/office/core/presentation"
import type { ShowOptions } from "@filen/office/react/presentation"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { setUpForm, setUpOptions, setUpRangeValid, type SetUpForm } from "@/features/presentation/components/slideshow/setUpDialog.logic"

// PowerPoint's Set Up Slide Show: who runs the show (a speaker, or a kiosk that loops and ignores clicks), whether it
// loops, which slides (all, a range, a custom show) and whether slides advance by their timings. Each opening starts
// from what the shows use now. `saved`: the settings are saved with the presentation (else kept until it closes);
// `odf`: saved in an OpenDocument presentation, which has no kiosk mode and runs a range to the last slide.
export function SetUpShowDialog({
	open,
	saved,
	odf,
	options,
	slideCount,
	customShows,
	onApply,
	onClose
}: {
	open: boolean
	saved: boolean
	odf: boolean
	options: ShowOptions
	slideCount: number
	customShows: readonly CustomShow[]
	onApply: (options: ShowOptions) => void
	onClose: () => void
}) {
	const { t } = useTranslation(["preview", "common"])
	const id = useId()
	const [edited, setEdited] = useState<SetUpForm | null>(null)
	const opened = edited ?? setUpForm(options, slideCount)
	const form = odf ? { ...opened, kiosk: false, to: String(slideCount) } : opened
	const change = (patch: Partial<SetUpForm>): void => {
		setEdited({ ...form, ...patch })
	}
	const close = (): void => {
		setEdited(null)
		onClose()
	}
	const rangeInvalid = form.slides === "range" && !setUpRangeValid(form, slideCount)
	const radio = (
		name: string,
		label: string,
		value: string,
		items: readonly (readonly [string, string, boolean?])[],
		onChange: (value: string) => void,
		description?: string
	) => (
		<Field>
			<FieldLabel id={`${id}-${name}`}>{label}</FieldLabel>
			<RadioGroup
				aria-labelledby={`${id}-${name}`}
				name={`${id}-${name}`}
				value={value}
				className="flex flex-col gap-2"
				onValueChange={next => {
					if (typeof next === "string") onChange(next)
				}}
			>
				{items.map(([item, text, disabled]) => (
					<div
						key={item}
						className="flex items-center gap-2"
					>
						<RadioGroupItem
							id={`${id}-${name}-${item}`}
							value={item}
							disabled={disabled === true}
						/>
						<Label htmlFor={`${id}-${name}-${item}`}>{text}</Label>
					</div>
				))}
			</RadioGroup>
			{description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
		</Field>
	)

	return (
		<FormDialog
			open={open}
			pending={false}
			title={t("previewPptxShowSetUpTitle")}
			description={t(saved ? "previewPptxShowSetUpDescriptionSaved" : "previewPptxShowSetUpDescription")}
			submitLabel={t("previewPptxShowSetUpApply")}
			cancelLabel={t("common:cancel")}
			canSubmit={!rangeInvalid}
			onOpenChange={next => {
				if (!next) close()
			}}
			onSubmit={event => {
				event.preventDefault()

				if (rangeInvalid) return

				onApply(setUpOptions(form, options))
				close()
			}}
		>
			<div className="flex flex-col gap-5">
				{radio(
					"type",
					t("previewPptxShowType"),
					form.kiosk ? "kiosk" : "speaker",
					[
						["speaker", t("previewPptxShowTypeSpeaker")],
						["kiosk", t("previewPptxShowTypeKiosk"), odf]
					],
					value => {
						change({ kiosk: value === "kiosk" })
					},
					odf ? t("previewPptxShowOdfNoKiosk") : undefined
				)}
				<Field orientation="horizontal">
					<Switch
						id={`${id}-loop`}
						checked={form.loop || form.kiosk}
						disabled={form.kiosk}
						onCheckedChange={checked => {
							change({ loop: checked })
						}}
					/>
					<Label htmlFor={`${id}-loop`}>{t("previewPptxShowLoop")}</Label>
				</Field>
				{radio(
					"slides",
					t("previewPptxShowSlides"),
					form.slides,
					[
						["all", t("previewPptxShowSlidesAll")],
						["range", t("previewPptxShowSlidesRange")],
						["custom", t("previewPptxShowSlidesCustom"), customShows.length === 0]
					],
					value => {
						if (value === "custom") change({ slides: value, custom: form.custom ?? customShows[0]?.id })
						else if (value === "all" || value === "range") change({ slides: value })
					}
				)}
				{form.slides === "range" ? (
					<Field data-invalid={rangeInvalid}>
						<div className="flex gap-3">
							<div className="flex min-w-0 flex-1 flex-col gap-1.5">
								<Label htmlFor={`${id}-from`}>{t("previewPptxShowSlidesFrom")}</Label>
								<Input
									id={`${id}-from`}
									inputMode="numeric"
									autoComplete="off"
									value={form.from}
									aria-invalid={rangeInvalid}
									onChange={event => {
										change({ from: event.target.value })
									}}
								/>
							</div>
							<div className="flex min-w-0 flex-1 flex-col gap-1.5">
								<Label htmlFor={`${id}-to`}>{t("previewPptxShowSlidesTo")}</Label>
								<Input
									id={`${id}-to`}
									inputMode="numeric"
									autoComplete="off"
									disabled={odf}
									value={form.to}
									aria-invalid={rangeInvalid}
									onChange={event => {
										change({ to: event.target.value })
									}}
								/>
							</div>
						</div>
						{odf ? <FieldDescription>{t("previewPptxShowOdfRangeToEnd")}</FieldDescription> : null}
						{rangeInvalid ? <FieldError>{t("previewPptxShowSlidesRangeInvalid", { count: slideCount })}</FieldError> : null}
					</Field>
				) : null}
				{form.slides === "custom" && customShows.length > 0 ? (
					<Field>
						<FieldLabel htmlFor={`${id}-custom`}>{t("previewPptxShowSlidesCustom")}</FieldLabel>
						<Select
							items={customShows.map(show => ({ value: String(show.id), label: show.name }))}
							value={String(form.custom ?? customShows[0]?.id ?? "")}
							onValueChange={(next: string | null) => {
								const found = customShows.find(show => String(show.id) === next)

								if (found !== undefined) change({ custom: found.id })
							}}
						>
							<SelectTrigger id={`${id}-custom`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent data-preview-surface>
								<SelectGroup>
									{customShows.map(show => (
										<SelectItem
											key={show.id}
											value={String(show.id)}
										>
											{show.name}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</Field>
				) : null}
				{radio(
					"advance",
					t("previewPptxShowAdvance"),
					form.timings || form.kiosk ? "timings" : "manual",
					[
						["manual", t("previewPptxShowAdvanceManual"), form.kiosk],
						["timings", t("previewPptxShowAdvanceTimings")]
					],
					value => {
						change({ timings: value === "timings" })
					}
				)}
			</div>
		</FormDialog>
	)
}
