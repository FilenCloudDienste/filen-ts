import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { FilmIcon, TvIcon, VideoIcon, type LucideIcon } from "lucide-react"
import type { CorrectionKind } from "@/features/videos/lib/corrections.logic"
import type { VideosKey } from "@/lib/i18n"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"

const ENTRIES: readonly { kind: CorrectionKind; icon: LucideIcon; label: VideosKey }[] = [
	{ kind: "movie", icon: FilmIcon, label: "detailKindMovie" },
	{ kind: "episode", icon: TvIcon, label: "setAsShow" },
	{ kind: "other", icon: VideoIcon, label: "detailKindOther" }
]

// Set as's entries, for a title's More menu (a submenu) and the selection bar (a menu): the kind the title already
// is (`current`) is shown disabled.
export function SetAsEntries({ current, onSetAs }: { current: CorrectionKind | null; onSetAs: (kind: CorrectionKind) => void }) {
	const { t } = useTranslation("videos")

	return ENTRIES.map(entry => (
		<DropdownMenuItem
			key={entry.kind}
			disabled={entry.kind === current}
			onClick={() => {
				onSetAs(entry.kind)
			}}
		>
			{createElement(entry.icon, { "aria-hidden": true })}
			{t(entry.label)}
		</DropdownMenuItem>
	))
}
