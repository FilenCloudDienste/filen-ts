import { useId } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { LockIcon } from "lucide-react"
import type { ArchiveLevels, CompressFormat } from "@filen/sdk-rs"
import { formatBytes } from "@filen/shared"
import { noDiskPersister } from "@/queries/persist"
import { archiveFormatInfos, compressFormatKey } from "@/features/drive/lib/archiveHelpers"
import { withLevel } from "@/features/drive/lib/archiveFormats"
import { PAGE_QUERY_OPTIONS } from "@/features/drive/components/compressDialog.logic"
import { Slider } from "@/components/ui/slider"
import { Label } from "@/components/ui/label"

function levelRange(min: number, max: number): number[] {
	return Array.from({ length: Math.max(0, max - min + 1) }, (_, index) => min + index)
}

export interface ArchiveLevelFieldProps {
	// The format at any level; the slider asks its encoder memory per level.
	probe: CompressFormat
	levels: ArchiveLevels
	// The highest level the archive memory budget runs, at least `levels.min`.
	maxLevel: number
	value: number
	onChange: (level: number) => void
	// The budget in bytes, for the note on the levels it doesn't run.
	budget: number
	disabled?: boolean | undefined
}

// Compression level, capped at what the budget runs: the slider's max is `maxLevel` (so its ARIA range
// and End key stay honest) and the levels above it show as a locked stretch of track with a note.
export function ArchiveLevelField({ probe, levels, maxLevel, value, onChange, budget, disabled }: ArchiveLevelFieldProps) {
	const { t } = useTranslation("archive")
	const id = useId()
	// One batched worker call per format and method, for the levels the slider can reach.
	const memoryQuery = useQuery({
		queryKey: ["archive", "levelMemory", compressFormatKey(probe)],
		queryFn: () => archiveFormatInfos(levelRange(levels.min, maxLevel).map(level => withLevel(probe, level))),
		...PAGE_QUERY_OPTIONS,
		persister: noDiskPersister
	})
	const memory = memoryQuery.data?.[value - levels.min]?.encoderMemory ?? null
	const valueText = memory === null ? null : t("archiveLevelValue", { level: value, memory: formatBytes(memory) })
	const locked = maxLevel < levels.max
	const span = levels.max - levels.min

	return (
		<div className="flex flex-col gap-2">
			<Label id={`${id}-label`}>{t("archiveLevelLabel")}</Label>
			<div className="flex items-center gap-3">
				<span className="shrink-0 text-xs text-muted-foreground">{t("archiveLevelFaster")}</span>
				<div className="flex min-w-0 flex-1 items-center">
					<Slider
						aria-labelledby={`${id}-label`}
						min={levels.min}
						max={maxLevel}
						step={1}
						value={value}
						disabled={disabled === true || maxLevel <= levels.min}
						getAriaValueText={valueText === null ? undefined : () => valueText}
						className="min-w-4"
						style={{ flexGrow: maxLevel - levels.min, flexBasis: 0 }}
						onValueChange={next => {
							const level = typeof next === "number" ? next : next[0]

							if (level !== undefined) {
								onChange(level)
							}
						}}
					/>
					{locked ? (
						<div
							aria-hidden
							className="ml-2 flex h-4 items-center gap-1 text-muted-foreground"
							style={{ flexGrow: span === 0 ? 1 : levels.max - maxLevel, flexBasis: 0 }}
						>
							<div className="h-1 flex-1 rounded-2xl bg-[repeating-linear-gradient(90deg,var(--color-input)_0_4px,transparent_4px_8px)]" />
							<LockIcon className="size-3.5 shrink-0" />
						</div>
					) : null}
				</div>
				<span className="shrink-0 text-xs text-muted-foreground">{t("archiveLevelSmaller")}</span>
			</div>
			<p className="min-h-5 text-sm text-muted-foreground tabular-nums">{valueText}</p>
			{locked ? (
				<p className="text-sm text-muted-foreground">
					<Link
						to="/settings/advanced"
						className="underline underline-offset-4 hover:text-primary"
					>
						{t("archiveLevelLocked", { from: maxLevel + 1, to: levels.max, budget: formatBytes(budget) })}
					</Link>
				</p>
			) : null}
		</div>
	)
}
