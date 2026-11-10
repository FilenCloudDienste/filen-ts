import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

const ROW_HEIGHT = 40
const OVERSCAN = 10

// The custom dictionary's words as a window over fixed-height rows: a dictionary of thousands draws what is in view.
// Its own file, as useVirtualizer opts it out of the React Compiler (the dialog stays compiled).
export function DictionaryWords({
	words,
	online,
	onRemove
}: {
	words: readonly string[]
	online: boolean
	onRemove: (word: string) => void
}) {
	const { t } = useTranslation("settings")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	// Memoized by hand: the virtualizer re-lays every row when its key function changes, so it changes with the words.
	const getItemKey = useCallback((index: number) => words[index] ?? index, [words])
	const virtualizer = useVirtualizer({
		count: words.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN,
		getItemKey
	})

	return (
		<div
			ref={setScrollElement}
			className="h-80 overflow-y-auto"
		>
			<ul
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(row => {
					const word = words[row.index]

					if (word === undefined) {
						return null
					}

					return (
						<li
							key={row.key}
							className="absolute top-0 left-0 flex w-full items-center justify-between gap-2 pr-1 pl-3"
							style={{ height: ROW_HEIGHT, transform: `translateY(${String(row.start)}px)` }}
						>
							<span className="min-w-0 truncate text-sm select-text">{word}</span>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								disabled={!online}
								aria-label={t("settingsOfficeDictionaryRemove", { word })}
								onClick={() => {
									onRemove(word)
								}}
							>
								<XIcon />
							</Button>
						</li>
					)
				})}
			</ul>
		</div>
	)
}
