import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ArrowLeftIcon, PackageSearchIcon } from "lucide-react"
import {
	filterThirdPartyNotices,
	thirdPartyLicenseTexts,
	THIRD_PARTY_NOTICES,
	type ThirdPartyNotice
} from "@/features/settings/lib/thirdPartyNotices"
import { ListFilterInput } from "@/components/listFilterInput"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"

export interface ThirdPartyNoticesDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
}

const ROW_HEIGHT = 52
const OVERSCAN = 10

// Both panes live in ONE dialog, swapped by local state — a nested dialog would fight the shared
// dismissal gate. Reached only through the lazy boundary in thirdPartyNoticesCard.tsx, which is what
// keeps the ~800 KB generated payload out of the entry chunk.
function ThirdPartyNoticesDialog({ open, onOpenChange }: ThirdPartyNoticesDialogProps) {
	const { t } = useTranslation("settings")
	const [query, setQuery] = useState("")
	const [selected, setSelected] = useState<ThirdPartyNotice | null>(null)
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const notices = filterThirdPartyNotices(THIRD_PARTY_NOTICES, query)

	const virtualizer = useVirtualizer({
		count: notices.length,
		getScrollElement: () => scrollElement,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN,
		getItemKey: index => {
			const notice = notices[index]

			return notice === undefined ? index : `${notice.ecosystem}:${notice.name}@${notice.version}`
		}
	})

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{selected === null ? t("settingsNoticesTitle") : selected.name}</DialogTitle>
					<DialogDescription>
						{selected === null
							? t("settingsNoticesCount", { count: notices.length })
							: `${selected.version} · ${selected.license}`}
					</DialogDescription>
				</DialogHeader>
				{selected === null ? (
					<div className="flex flex-col gap-3">
						<ListFilterInput
							value={query}
							onChange={setQuery}
							placeholder={t("settingsNoticesFilterPlaceholder")}
							ariaLabel={t("settingsNoticesFilterPlaceholder")}
						/>
						{notices.length === 0 ? (
							<Empty className="h-96">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<PackageSearchIcon />
									</EmptyMedia>
									<EmptyDescription>{t("settingsNoticesEmpty")}</EmptyDescription>
								</EmptyHeader>
							</Empty>
						) : (
							<div
								ref={setScrollElement}
								className="h-96 overflow-y-auto"
							>
								<div
									className="relative w-full"
									style={{ height: virtualizer.getTotalSize() }}
								>
									{virtualizer.getVirtualItems().map(virtualRow => {
										const notice = notices[virtualRow.index]

										if (!notice) {
											return null
										}

										return (
											<div
												key={virtualRow.key}
												className="absolute top-0 left-0 w-full"
												style={{ height: ROW_HEIGHT, transform: `translateY(${String(virtualRow.start)}px)` }}
											>
												<Button
													variant="ghost"
													className="h-12 w-full justify-start px-3"
													onClick={() => {
														setSelected(notice)
													}}
												>
													<span className="flex min-w-0 flex-col items-start gap-0.5">
														<span className="w-full truncate text-sm">{notice.name}</span>
														<span className="w-full truncate text-xs font-normal text-muted-foreground">
															{notice.version} · {notice.license}
														</span>
													</span>
												</Button>
											</div>
										)
									})}
								</div>
							</div>
						)}
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<Button
							variant="ghost"
							size="sm"
							className="self-start"
							onClick={() => {
								setSelected(null)
							}}
						>
							<ArrowLeftIcon />
							{t("settingsNoticesBack")}
						</Button>
						{selected.repository === null ? null : (
							<a
								href={selected.repository}
								target="_blank"
								rel="noopener noreferrer"
								className="truncate text-xs text-muted-foreground underline underline-offset-4"
							>
								{selected.repository}
							</a>
						)}
						{/* License prose is long-form text a user may want to copy, and the app body is select-none. */}
						<div className="flex h-96 flex-col gap-3 overflow-y-auto rounded-2xl bg-muted/40 p-3 text-xs select-text">
							{selected.copyright.map(line => (
								<p key={line}>{line}</p>
							))}
							{thirdPartyLicenseTexts(selected).map(text => (
								<pre
									key={text}
									className="font-mono whitespace-pre-wrap"
								>
									{text}
								</pre>
							))}
							{selected.texts.length === 0 ? (
								<p className="text-muted-foreground">{t("settingsNoticesNoLicenseText")}</p>
							) : null}
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	)
}

export { ThirdPartyNoticesDialog }
export default ThirdPartyNoticesDialog
