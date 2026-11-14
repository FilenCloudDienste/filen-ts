import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { XIcon } from "lucide-react"
import type { RedactionFinding, RedactionPreset, RedactionQuery } from "@filen/office/core/pdfedit/redactVerify"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
	addTerm,
	canSearch,
	DEFAULT_FIND_FORM,
	findQuery,
	selectedFindings,
	togglePreset,
	type FindRedactForm
} from "@/features/pdf/redact/redaction.logic"

// Find & redact: literal words or phrases (never patterns) with case and whole-word options, and ready-made searches
// for email addresses and phone numbers. The results arrive from the engine as a review list, all selected; the
// selected ones are marked for redaction (nothing is removed until the marks are applied).

export interface FindRedactPanelProps {
	// The last search's results; null before any search.
	findings: readonly RedactionFinding[] | null
	searching: boolean
	onSearch: (query: RedactionQuery, form: FindRedactForm) => void
	onMark: (findings: readonly RedactionFinding[]) => void
	onClose: () => void
}

const PRESETS: readonly {
	readonly preset: RedactionPreset
	readonly label: "previewPdfFindRedactEmails" | "previewPdfFindRedactPhones"
}[] = [
	{ preset: "emails", label: "previewPdfFindRedactEmails" },
	{ preset: "phoneNumbers", label: "previewPdfFindRedactPhones" }
]

export function FindRedactPanel({ findings, searching, onSearch, onMark, onClose }: FindRedactPanelProps) {
	const { t } = useTranslation("preview")
	const id = useId()
	const [form, setForm] = useState<FindRedactForm>(DEFAULT_FIND_FORM)
	const [typed, setTyped] = useState("")
	// Ids of unselected findings: a new search starts with every result selected.
	const [unselected, setUnselected] = useState<ReadonlySet<string>>(new Set())
	const [shown, setShown] = useState<readonly RedactionFinding[] | null>(null)

	if (findings !== shown) {
		setShown(findings)
		setUnselected(new Set())
	}

	const results = findings ?? []
	const selected = new Set(results.filter(finding => !unselected.has(finding.id)).map(finding => finding.id))
	const chosen = selectedFindings(results, selected)
	const withTyped = addTerm(form.terms, typed)
	const ready = canSearch({ ...form, terms: withTyped }) && !searching

	const add = (): void => {
		setForm({ ...form, terms: addTerm(form.terms, typed) })
		setTyped("")
	}

	const search = (): void => {
		const next = { ...form, terms: withTyped }

		setForm(next)
		setTyped("")
		onSearch(findQuery(next), next)
	}

	const toggle = (finding: RedactionFinding, on: boolean): void => {
		const next = new Set(unselected)

		if (on) next.delete(finding.id)
		else next.add(finding.id)

		setUnselected(next)
	}

	return (
		<section
			aria-labelledby={`${id}-title`}
			className="flex h-full min-h-0 flex-col gap-3 p-3"
		>
			<header className="flex items-center justify-between gap-2">
				<h2
					id={`${id}-title`}
					className="text-sm font-semibold"
				>
					{t("previewPdfFindRedactTitle")}
				</h2>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={t("previewPdfFindRedactClose")}
					onClick={onClose}
				>
					<XIcon aria-hidden />
				</Button>
			</header>
			<form
				className="flex flex-col gap-2"
				onSubmit={event => {
					event.preventDefault()

					if (typed.trim().length > 0) add()
					else if (ready) search()
				}}
			>
				<Label htmlFor={`${id}-term`}>{t("previewPdfFindRedactTermLabel")}</Label>
				<div className="flex gap-2">
					<Input
						id={`${id}-term`}
						value={typed}
						placeholder={t("previewPdfFindRedactTermPlaceholder")}
						autoComplete="off"
						spellCheck={false}
						className="leading-5"
						onChange={event => {
							setTyped(event.target.value)
						}}
					/>
					<Button
						type="submit"
						variant="outline"
						disabled={typed.trim().length === 0}
					>
						{t("previewPdfFindRedactAddTerm")}
					</Button>
				</div>
				{form.terms.length > 0 ? (
					<ul className="flex flex-wrap gap-1">
						{form.terms.map(term => (
							<li
								key={term}
								className="flex items-center gap-1 rounded-2xl bg-secondary py-0.5 pr-0.5 pl-2.5 text-xs"
							>
								<span className="max-w-48 truncate">{term}</span>
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label={t("previewPdfFindRedactRemoveTerm", { term })}
									onClick={() => {
										setForm({ ...form, terms: form.terms.filter(item => item !== term) })
									}}
								>
									<XIcon aria-hidden />
								</Button>
							</li>
						))}
					</ul>
				) : null}
			</form>
			<div className="flex flex-col gap-1.5">
				<Option
					id={`${id}-case`}
					checked={form.matchCase}
					label={t("previewPdfFindRedactMatchCase")}
					onChange={on => {
						setForm({ ...form, matchCase: on })
					}}
				/>
				<Option
					id={`${id}-whole`}
					checked={form.wholeWord}
					label={t("previewPdfFindRedactWholeWords")}
					onChange={on => {
						setForm({ ...form, wholeWord: on })
					}}
				/>
			</div>
			<fieldset className="flex flex-col gap-1.5">
				<legend className="mb-1 text-sm font-medium">{t("previewPdfFindRedactPresets")}</legend>
				{PRESETS.map(({ preset, label }) => (
					<Option
						key={preset}
						id={`${id}-${preset}`}
						checked={form.presets.includes(preset)}
						label={t(label)}
						onChange={on => {
							setForm({ ...form, presets: togglePreset(form.presets, preset, on) })
						}}
					/>
				))}
			</fieldset>
			<Button
				disabled={!ready}
				onClick={search}
			>
				{searching ? t("previewPdfFindRedactSearching") : t("previewPdfFindRedactSearch")}
			</Button>
			{findings === null ? null : (
				<div className="flex min-h-0 flex-1 flex-col gap-2">
					<div
						className="flex items-center justify-between gap-2 text-sm"
						aria-live="polite"
					>
						<span>
							{results.length === 0
								? t("previewPdfFindRedactNoResults")
								: t("previewPdfFindRedactResults", { count: results.length })}
						</span>
						{results.length > 0 ? (
							<Option
								id={`${id}-all`}
								checked={chosen.length === results.length}
								label={t("previewPdfFindRedactSelectAll")}
								onChange={on => {
									setUnselected(on ? new Set() : new Set(results.map(finding => finding.id)))
								}}
							/>
						) : null}
					</div>
					<ul className="min-h-0 flex-1 overflow-y-auto">
						{results.map(finding => (
							<li
								key={finding.id}
								className="flex items-start gap-2 py-1"
							>
								<input
									id={`${id}-f-${finding.id}`}
									type="checkbox"
									className="mt-0.5 size-4 shrink-0 accent-primary"
									checked={selected.has(finding.id)}
									onChange={event => {
										toggle(finding, event.target.checked)
									}}
								/>
								<Label
									htmlFor={`${id}-f-${finding.id}`}
									className="flex min-w-0 flex-col items-start gap-0 font-normal"
								>
									<span className="max-w-full truncate">{finding.text}</span>
									<span className="text-xs text-muted-foreground">
										{t("previewPdfFindRedactResultPage", { page: finding.page + 1 })}
									</span>
								</Label>
							</li>
						))}
					</ul>
					{results.length > 0 ? (
						<Button
							disabled={chosen.length === 0}
							onClick={() => {
								onMark(chosen)
							}}
						>
							{t("previewPdfFindRedactMark", { count: chosen.length })}
						</Button>
					) : null}
				</div>
			)}
		</section>
	)
}

function Option({ id, checked, label, onChange }: { id: string; checked: boolean; label: string; onChange: (on: boolean) => void }) {
	return (
		<div className="flex items-center gap-2">
			<input
				id={id}
				type="checkbox"
				className="size-4 accent-primary"
				checked={checked}
				onChange={event => {
					onChange(event.target.checked)
				}}
			/>
			<Label htmlFor={id}>{label}</Label>
		</div>
	)
}
