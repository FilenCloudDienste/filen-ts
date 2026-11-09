import { useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate } from "@tanstack/react-router"
import { InfoIcon, PlayIcon } from "lucide-react"
import { formatSecondsToMediaClock } from "@filen/shared"
import { useVideoArt } from "@/features/videos/hooks/useVideoArt"
import { probeRecords } from "@/features/videos/lib/records"
import type { ProbeRecord } from "@/features/videos/lib/probeService.logic"
import type { HeroModel } from "@/features/videos/lib/homeRows.logic"
import { neutralTone } from "@/features/videos/lib/videoCard.logic"
import { ArtImage } from "@/features/videos/components/videoCard"
import { qualityLabel } from "@/features/videos/lib/videoGrid.logic"
import { Button, buttonVariants } from "@/components/ui/button"

// What the file's stored probe says (a local read; nothing is probed for the hero).
function useStoredProbe(uuid: string | null): ProbeRecord | null {
	const [state, setState] = useState<{ uuid: string | null; record: ProbeRecord | null }>({ uuid: null, record: null })

	useEffect(() => {
		if (uuid === null) {
			return
		}

		let cancelled = false

		probeRecords
			.get(uuid)
			.then(record => {
				if (!cancelled) {
					setState({ uuid, record })
				}
			})
			.catch(() => undefined)

		return () => {
			cancelled = true
		}
	}, [uuid])

	return state.uuid === uuid ? state.record : null
}

// The home's static hero: one title per session on a dark rounded card under the header, its backdrop behind a
// scrim, the title, what is known of it, Play or Resume, and More info (the title's page). No rotation, no trailer.
export function HomeHero({ hero, now, onShown }: { hero: HeroModel; now: number; onShown: (titleId: string) => void }) {
	const { t } = useTranslation("videos")
	const navigate = useNavigate()
	const headingId = useId()
	const [element, setElement] = useState<HTMLElement | null>(null)
	const { title, card } = hero
	const playUuid = card?.play ?? title.primary?.stableUuid ?? null
	const fileUuid = card?.item?.uuid ?? title.primary?.uuid ?? null
	const art = useVideoArt({ titleId: title.id, stableUuid: null, slot: "b", title: title.title, near: true, element })
	const probe = useStoredProbe(fileUuid)?.probe ?? null
	const titleId = title.id

	useEffect(() => {
		onShown(titleId)
	}, [onShown, titleId])

	const resumeSec = card?.resumeSec ?? 0
	const duration = probe?.durationSec ?? null
	const height = title.height > 0 ? title.height : (probe?.video?.h ?? 0)
	const channels = probe?.audio.find(track => track.def)?.ch ?? probe?.audio[0]?.ch ?? null
	const meta: string[] = []

	if (title.year > 0) {
		meta.push(String(title.year))
	}

	if (duration !== null && duration > 0) {
		const minutes = Math.round(duration / 60)

		meta.push(
			minutes >= 60
				? t("videosHomeRuntimeHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
				: t("videosHomeRuntimeMinutes", { minutes })
		)
	}

	const quality = qualityLabel(height)

	if (quality.length > 0) {
		meta.push(quality)
	}

	if (probe?.video?.transfer === "pq" || probe?.video?.transfer === "hlg") {
		meta.push(t("videosHomeHdr"))
	}

	if (channels !== null && channels >= 6) {
		meta.push(`${String(channels - 1)}.1`)
	}

	if (duration !== null && duration > resumeSec) {
		const endsAt = new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(now + (duration - resumeSec) * 1000)

		meta.push(t("videosHomeEndsAt", { time: endsAt }))
	}

	return (
		<section
			ref={setElement}
			aria-labelledby={headingId}
			className="dark relative isolate flex h-[clamp(280px,48vh,560px)] shrink-0 flex-col justify-end overflow-hidden rounded-xl bg-black text-foreground md:rounded-[24px]"
		>
			{/* Without a backdrop, a gradient on the title's tone; the image fades in over it when one loads. */}
			<div
				aria-hidden="true"
				className="absolute inset-0 -z-10"
				style={{ background: `radial-gradient(120% 140% at 85% 10%, ${neutralTone(title.title)}, #000 70%)` }}
			>
				{art.kind === "image" ? (
					<ArtImage
						key={art.url}
						url={art.url}
						fit="cover"
					/>
				) : null}
			</div>
			<div
				aria-hidden="true"
				className="absolute inset-0 -z-10 bg-linear-to-t from-black/90 via-black/45 to-black/5"
			/>
			<div
				aria-hidden="true"
				className="absolute inset-0 -z-10 bg-linear-to-r from-black/60 to-transparent"
			/>
			<div className="flex max-w-2xl flex-col gap-2 p-5 sm:p-8">
				<h2
					id={headingId}
					className="text-2xl font-semibold tracking-tight text-white sm:text-4xl"
				>
					{title.title}
				</h2>
				{meta.length > 0 ? <p className="text-sm text-white/80 tabular-nums">{meta.join(" · ")}</p> : null}
				<div className="mt-2 flex gap-2">
					{playUuid === null ? null : (
						<Button
							size="lg"
							onClick={() => {
								void navigate({ to: "/videos/watch/$uuid", params: { uuid: title.id }, search: { file: playUuid } })
							}}
						>
							<PlayIcon
								data-icon="inline-start"
								className="fill-current"
							/>
							{resumeSec > 0 ? t("videosHomeResume", { time: formatSecondsToMediaClock(resumeSec) }) : t("videosHomePlay")}
						</Button>
					)}
					<Link
						to="/videos/title/$uuid"
						params={{ uuid: title.id }}
						className={buttonVariants({ variant: "secondary", size: "lg" })}
					>
						<InfoIcon data-icon="inline-start" />
						{t("detailMoreInfo")}
					</Link>
				</div>
			</div>
		</section>
	)
}
