import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { DesktopApp } from "@filen/shared/desktop"
import { ArrowLeftIcon, PackageSearchIcon } from "lucide-react"
import {
	filterThirdPartyNotices,
	licenseTextsIn,
	thirdPartyNoticesPayload,
	withDesktopNotices,
	type ThirdPartyNotice,
	type ThirdPartyNoticesPayload
} from "@/features/settings/lib/thirdPartyNotices"
import { desktopBridge } from "@/lib/desktop"
import { log } from "@/lib/log"
import { noDiskPersister } from "@/queries/persist"
import { noticeLacksCopyright, noticeRepositoryHref } from "@/features/settings/components/advanced/thirdPartyNoticesDialog.logic"
import { ListFilterInput } from "@/components/listFilterInput"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

export interface ThirdPartyNoticesDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
}

const ROW_HEIGHT = 52
const OVERSCAN = 10

// In the desktop app, the notices of what its shell adds to this build, merged in once the dialog first opens. Never
// persisted: the shell reads them from disk, which is cheaper than the query cache would be.
async function desktopNotices(app: DesktopApp): Promise<ThirdPartyNoticesPayload> {
	try {
		return withDesktopNotices(thirdPartyNoticesPayload(), await app.thirdPartyNotices())
	} catch (e) {
		log.error("settings.notices", "reading the desktop shell's notices failed", e)

		throw e
	}
}

// The web build's notices until the shell's arrive, and still them if reading those failed; in a browser, only them.
function useThirdPartyNotices(open: boolean): ThirdPartyNoticesPayload {
	const app = desktopBridge()?.app
	const { data } = useQuery({
		queryKey: ["settings", "thirdPartyNotices", "desktop"],
		queryFn: () => (app === undefined ? thirdPartyNoticesPayload() : desktopNotices(app)),
		persister: noDiskPersister,
		enabled: open && app !== undefined,
		staleTime: Infinity,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false
	})

	return data ?? thirdPartyNoticesPayload()
}

export function ThirdPartyNoticesDialog({ open, onOpenChange }: ThirdPartyNoticesDialogProps) {
	const { t } = useTranslation("settings")
	const [query, setQuery] = useState("")
	const [selected, setSelected] = useState<ThirdPartyNotice | null>(null)
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	// Memoized by hand (useVirtualizer opts this component out of the React Compiler): the virtualizer
	// re-lays every row when its key function changes, so the filtered list and its key function must
	// change with the query (and the desktop shell's notices arriving) and nothing else, not on every scroll render.
	const payload = useThirdPartyNotices(open)
	const notices = useMemo(() => filterThirdPartyNotices(payload.notices, query), [payload, query])
	const repositoryHref = noticeRepositoryHref(selected?.repository ?? null)
	const getItemKey = useCallback(
		(index: number) => {
			const notice = notices[index]

			return notice === undefined ? index : `${notice.ecosystem}:${notice.name}@${notice.version}`
		},
		[notices]
	)

	const virtualizer = useVirtualizer({
		count: notices.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN,
		getItemKey
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
									<EmptyMedia>
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
						{selected.repository === null ? null : repositoryHref === null ? (
							<span className="truncate text-xs text-muted-foreground">{selected.repository}</span>
						) : (
							<a
								href={repositoryHref}
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
							{noticeLacksCopyright(selected) ? (
								<p className="text-muted-foreground">{t("settingsNoticesNoCopyrightLine")}</p>
							) : null}
							{licenseTextsIn(payload, selected).map(text => (
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
