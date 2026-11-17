import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import * as Comlink from "comlink"
import { CodeIcon, MapIcon, MaximizeIcon } from "lucide-react"
import { driveItemName } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import { itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { Button } from "@/components/ui/button"
import { resolveTheme, useTheme } from "@/providers/themeProvider"
import { useOwnedWorker } from "@/lib/workers/ownedWorker"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { CanvasViewerShell } from "@/features/preview/components/canvasViewerShell"
import { TextViewer } from "@/features/preview/components/textViewer"
import { PreviewGate, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import GeoWorker from "@/features/preview/workers/geo.worker.ts?worker"
import type { GeoColors, GeoSummary, GeoWorkerApi } from "@/features/preview/workers/geo.worker"
import type { GeoStats } from "@/features/preview/lib/geo/stats.logic"
import {
	distanceParts,
	duration,
	geoFormat,
	kilometresPerHour,
	nearestSample,
	profilePath,
	wholeMetres
} from "@/features/preview/components/geoViewer.logic"

type LoadState = { status: "loading" } | { status: "ready"; summary: GeoSummary } | { status: "failed" }

const PROFILE_WIDTH = 1000
const PROFILE_HEIGHT = 64

function createGeoWorker(): Worker {
	return new GeoWorker()
}

function palette(dark: boolean): GeoColors {
	return dark
		? {
				track: "#60a5fa",
				waypoint: "#fbbf24",
				start: "#4ade80",
				end: "#f87171",
				highlight: "#c084fc",
				text: "#e5e7eb",
				halo: "#0b0b0f"
			}
		: {
				track: "#2563eb",
				waypoint: "#d97706",
				start: "#16a34a",
				end: "#dc2626",
				highlight: "#9333ea",
				text: "#111827",
				halo: "#ffffff"
			}
}

function useDistance(): (metres: number) => string {
	const { t } = useTranslation("preview")

	return metres => {
		const parts = distanceParts(metres)

		return t(parts.unit === "km" ? "previewGeoKilometres" : "previewGeoMetres", { value: parts.value })
	}
}

// "42.3 km · ↑ 612 m ↓ 598 m · 2:11:04 (1:58:10 moving) · 1,204 points".
function Summary({ stats, waypoints }: { stats: GeoStats; waypoints: number }) {
	const { t } = useTranslation("preview")
	const distance = useDistance()
	const metres = (value: number): string => t("previewGeoMetres", { value: wholeMetres(value) })
	const parts = [distance(stats.distance)]

	if (stats.maxElevation !== null) parts.push(t("previewGeoClimb", { gain: metres(stats.gain), loss: metres(stats.loss) }))
	if (stats.duration !== null && stats.duration > 0)
		parts.push(t("previewGeoTime", { duration: duration(stats.duration), moving: duration(stats.moving ?? 0) }))
	if (stats.maxSpeed !== null && stats.maxSpeed > 0)
		parts.push(t("previewGeoTopSpeed", { speed: t("previewGeoSpeed", { value: kilometresPerHour(stats.maxSpeed) }) }))

	parts.push(t("previewGeoPoints", { count: stats.points }))

	if (waypoints > 0) parts.push(t("previewGeoWaypoints", { count: waypoints }))

	return <p className="truncate px-4 pt-3 pb-2 text-sm text-muted-foreground">{parts.join(" · ")}</p>
}

function Profile({ summary, onHover }: { summary: GeoSummary; onHover: (distance: number | null) => void }) {
	const { t } = useTranslation("preview")
	const distance = useDistance()
	const [hover, setHover] = useState<number | null>(null)
	const { distance: at, elevation } = summary.profile
	const total = at.at(-1) ?? 0

	if (at.length < 2 || total <= 0) {
		return null
	}

	const move = (event: ReactPointerEvent<SVGSVGElement>): void => {
		const box = event.currentTarget.getBoundingClientRect()
		const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(1, box.width)))
		const sample = nearestSample(at, fraction * total)

		setHover(sample)
		onHover(sample < 0 ? null : (at[sample] ?? 0))
	}
	const sample = hover ?? -1

	return (
		<div className="relative shrink-0 border-t border-border/50 px-4 py-2">
			<svg
				role="img"
				aria-label={t("previewGeoProfile")}
				viewBox={`0 0 ${String(PROFILE_WIDTH)} ${String(PROFILE_HEIGHT)}`}
				preserveAspectRatio="none"
				className="block h-16 w-full touch-none text-primary"
				onPointerMove={move}
				onPointerLeave={() => {
					setHover(null)
					onHover(null)
				}}
			>
				<path
					d={profilePath(at, elevation, PROFILE_WIDTH, PROFILE_HEIGHT)}
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
					vectorEffect="non-scaling-stroke"
				/>
				{sample >= 0 ? (
					<line
						x1={((at[sample] ?? 0) / total) * PROFILE_WIDTH}
						x2={((at[sample] ?? 0) / total) * PROFILE_WIDTH}
						y1={0}
						y2={PROFILE_HEIGHT}
						stroke="currentColor"
						strokeOpacity={0.5}
						vectorEffect="non-scaling-stroke"
					/>
				) : null}
			</svg>
			{sample >= 0 ? (
				<span className="pointer-events-none absolute top-1 right-4 text-xs text-muted-foreground tabular-nums">
					{t("previewGeoProfileAt", {
						distance: distance(at[sample] ?? 0),
						elevation: t("previewGeoMetres", { value: wholeMetres(elevation[sample] ?? 0) })
					})}
				</span>
			) : null}
		</div>
	)
}

function GeoPlot({ item, bytes, onSource }: { item: DriveItem; bytes: Uint8Array; onSource: (() => void) | null }) {
	const { t } = useTranslation("preview")
	const { theme } = useTheme()
	const dark = resolveTheme(theme) === "dark"
	const format = geoFormat(itemTypeExtension(item))
	const [attempt, setAttempt] = useState(0)
	const worker = useOwnedWorker<GeoWorkerApi>(createGeoWorker, `${item.data.uuid}:${String(attempt)}`, "geo")
	const owned = worker.status === "ready" ? worker.owned : null
	const generation = worker.status === "ready" ? worker.generation : 0
	const [state, setState] = useState<{ owner: object; load: LoadState } | null>(null)
	const load = state !== null && state.owner === owned ? state.load : { status: "loading" as const }
	const [colors] = useState(() => palette(dark))

	useEffect(() => {
		if (owned === null || format === null) {
			return
		}

		let live = true
		// The page keeps its bytes (View source reads them); the worker gets a copy.
		const copy = bytes.slice()

		owned
			.run(remote => remote.load(Comlink.transfer(copy, [copy.buffer]), format, colors))
			.then(
				summary => {
					if (live) setState({ owner: owned, load: { status: "ready", summary } })
				},
				() => {
					if (live) setState({ owner: owned, load: { status: "failed" } })
				}
			)

		return () => {
			live = false
		}
	}, [owned, bytes, format, colors])

	useEffect(() => {
		if (owned !== null) void owned.run(remote => remote.setColors(palette(dark))).catch(() => undefined)
	}, [owned, dark])

	const source =
		onSource === null ? undefined : (
			<Button
				variant="outline"
				onClick={onSource}
			>
				{t("previewGeoShowSource")}
			</Button>
		)

	if (format === null || worker.status === "failed" || load.status === "failed") {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewGeoUnreadable")}
				secondary={source}
			/>
		)
	}

	if (owned === null || load.status === "loading") {
		return <PreviewLoading />
	}

	const { summary } = load
	const plotted = !summary.tooMany && summary.stats.points + summary.waypoints > 0

	return (
		<div className="flex size-full min-h-0 flex-col">
			<Summary
				stats={summary.stats}
				waypoints={summary.waypoints}
			/>
			<div className="relative min-h-0 flex-1">
				{plotted ? (
					<CanvasViewerShell
						item={item}
						session={generation}
						label={t("previewGeoMapLabel")}
						connect={port => {
							void owned.run(remote => remote.attach(Comlink.transfer(port, [port])))
						}}
						onReload={() => {
							setAttempt(previous => previous + 1)
						}}
						notice={
							summary.references > 0 ? (
								<span className="rounded-md bg-background/80 px-2 py-1 text-muted-foreground">
									{t("previewGeoReferences", { count: summary.references })}
								</span>
							) : undefined
						}
						toolbar={
							<div className="flex gap-2 rounded-xl bg-background/80 p-1 shadow-sm">
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										void owned.run(remote => remote.fit())
									}}
								>
									<MaximizeIcon data-icon="inline-start" />
									{t("previewGeoFit")}
								</Button>
								{onSource === null ? null : (
									<Button
										variant="ghost"
										size="sm"
										onClick={onSource}
									>
										<CodeIcon data-icon="inline-start" />
										{t("previewGeoShowSource")}
									</Button>
								)}
							</div>
						}
					/>
				) : (
					<PreviewUnsupportedState
						item={item}
						message={t(summary.tooMany ? "previewGeoTooMany" : "previewGeoEmpty")}
						secondary={source}
					/>
				)}
			</div>
			{plotted ? (
				<Profile
					summary={summary}
					onHover={distance => {
						void owned.run(remote => remote.highlight(distance)).catch(() => undefined)
					}}
				/>
			) : null}
		</div>
	)
}

// A GPS track or map shapes file (GPX, KML, KMZ, GeoJSON): its figures, a plot of its lines and places (no basemap,
// nothing fetched), and the elevation profile. A text format's source is a button away.
export function GeoViewer({ item }: { item: DriveItem }) {
	const { t } = useTranslation("preview")
	const result = usePreviewBytes(item)
	const [source, setSource] = useState(false)
	// A KMZ is a zip: no text to show.
	const textual = itemTypeExtension(item) !== "kmz"

	if (source) {
		return (
			<div className="flex size-full min-h-0 flex-col">
				<div className="flex shrink-0 justify-end px-3 py-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							setSource(false)
						}}
					>
						<MapIcon data-icon="inline-start" />
						{t("previewGeoShowMap")}
					</Button>
				</div>
				<div className="min-h-0 flex-1">
					<TextViewer
						item={item}
						alt={driveItemName(item)}
					/>
				</div>
			</div>
		)
	}

	return (
		<PreviewGate result={result}>
			{ready => (
				<GeoPlot
					item={item}
					bytes={ready.bytes}
					onSource={
						textual
							? () => {
									setSource(true)
								}
							: null
					}
				/>
			)}
		</PreviewGate>
	)
}
