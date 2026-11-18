import { useEffect, useEffectEvent, useState } from "react"
import { useTranslation } from "react-i18next"
import * as Comlink from "comlink"
import { CodeIcon, LayersIcon, MaximizeIcon, MoonIcon, PencilRulerIcon } from "lucide-react"
import { driveItemName } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import { Button } from "@/components/ui/button"
import { resolveTheme, useTheme } from "@/providers/themeProvider"
import { useOwnedWorker, type OwnedWorker } from "@/lib/workers/ownedWorker"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { CanvasViewerShell } from "@/features/preview/components/canvasViewerShell"
import { TextViewer } from "@/features/preview/components/textViewer"
import { PreviewGate, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import DxfWorker from "@/features/preview/workers/dxf.worker.ts?worker"
import type { DxfLayer, DxfLoad, DxfShellStatus, DxfWorkerApi } from "@/features/preview/workers/dxf.worker"

function createDxfWorker(): Worker {
	return new DxfWorker()
}

type Owned = OwnedWorker<DxfWorkerApi>

// One load per worker: an effect that runs twice (StrictMode) joins the first.
const loads = new WeakMap<object, Promise<DxfLoad>>()

const FAILED: DxfLoad = { status: "malformed", layers: [], moreLayers: 0, missingGlyphs: false, skipped: 0 }
// A load still running after this long is ended: whatever the scene's budget lets through, no drawing takes this long.
export const DXF_LOAD_TIMEOUT_MS = 30_000
const TIMED_OUT: DxfLoad = { ...FAILED, status: "tooComplex" }
// Fresh workers started by themselves for a display that did not come back, per file; then the card (a drawing that
// resets the GPU would otherwise reset it again and again, and the browser then blocks WebGL for the whole app).
export const DXF_MAX_RESTARTS = 1

const STATE_MESSAGES = {
	empty: "previewCadEmpty",
	tooComplex: "previewCadTooComplex",
	malformed: "previewCadUnreadable",
	noWebgl: "previewCadNoWebgl"
} as const

function LayersPanel({
	layers,
	more,
	hidden,
	onToggle
}: {
	layers: readonly DxfLayer[]
	more: number
	hidden: ReadonlySet<string>
	onToggle: (name: string, visible: boolean) => void
}) {
	const { t } = useTranslation("preview")

	return (
		<div className="flex flex-col gap-1 p-3 text-sm">
			<p className="px-1 pb-1 font-medium">{t("previewCadLayers")}</p>
			<ul
				aria-label={t("previewCadLayerList")}
				className="flex flex-col"
			>
				{layers.map(layer => (
					<li key={layer.name}>
						<label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-muted">
							<input
								type="checkbox"
								className="size-4 shrink-0 accent-primary"
								checked={!hidden.has(layer.name)}
								onChange={event => {
									onToggle(layer.name, event.target.checked)
								}}
							/>
							<span
								aria-hidden="true"
								className="size-3 shrink-0 rounded-sm border"
								style={{ backgroundColor: layer.color }}
							/>
							<span className="min-w-0 truncate">{layer.label}</span>
						</label>
					</li>
				))}
			</ul>
			{more > 0 ? <p className="px-1 pt-1 text-muted-foreground">{t("previewCadMoreLayers", { count: more })}</p> : null}
		</div>
	)
}

function DxfDrawing({ item, bytes, onSource }: { item: DriveItem; bytes: Uint8Array; onSource: () => void }) {
	const { t } = useTranslation("preview")
	const { theme } = useTheme()
	const [attempt, setAttempt] = useState(0)
	const worker = useOwnedWorker<DxfWorkerApi>(createDxfWorker, `${item.data.uuid}:${String(attempt)}`, "dxf")
	const owned = worker.status === "ready" ? worker.owned : null
	const generation = worker.status === "ready" ? worker.generation : 0
	const [state, setState] = useState<{ owner: object; load: DxfLoad } | null>(null)
	const load = state !== null && state.owner === owned ? state.load : null
	// The background starts with the app's theme; the toolbar flips it.
	const [dark, setDark] = useState(() => resolveTheme(theme) === "dark")
	const [panel, setPanel] = useState<boolean | null>(null)
	const [hidden, setHidden] = useState<{ owner: object | null; names: ReadonlySet<string> }>({ owner: null, names: new Set() })
	const hiddenNames = hidden.owner === owned ? hidden.names : new Set<string>()
	const [restarts, setRestarts] = useState(0)
	const [displayLost, setDisplayLost] = useState(false)
	// A new worker over the bytes still held: Reload viewer.
	const restart = (): void => {
		setAttempt(previous => previous + 1)
	}
	// The worker's display did not come back: a fresh one, a limited number of times.
	const restartLost = (): void => {
		if (restarts >= DXF_MAX_RESTARTS) {
			setDisplayLost(true)

			return
		}

		setRestarts(restarts + 1)
		restart()
	}
	const start = useEffectEvent((target: Owned): Promise<DxfLoad> => {
		// The page keeps its bytes (View source reads them); the worker reads a Blob of them, which it lets go once parsed.
		const drawing = new Blob([bytes as Uint8Array<ArrayBuffer>])

		return target.run(remote => remote.load(drawing, dark))
	})

	useEffect(() => {
		if (owned === null) return

		let live = true
		let timedOut = false
		const pending = loads.get(owned) ?? start(owned)
		const timer = setTimeout(() => {
			timedOut = true
			owned.terminate()
		}, DXF_LOAD_TIMEOUT_MS)

		loads.set(owned, pending)
		pending.then(
			loaded => {
				clearTimeout(timer)

				if (live) setState({ owner: owned, load: loaded })
			},
			() => {
				clearTimeout(timer)

				if (live) setState({ owner: owned, load: timedOut ? TIMED_OUT : FAILED })
			}
		)

		return () => {
			live = false
			clearTimeout(timer)
		}
	}, [owned])

	const source = (
		<Button
			variant="outline"
			onClick={onSource}
		>
			{t("previewCadShowSource")}
		</Button>
	)

	if (displayLost) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewRichShellContextFailed")}
				secondary={source}
			/>
		)
	}

	if (worker.status === "failed") {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewCadUnreadable")}
				secondary={source}
			/>
		)
	}

	if (owned === null) {
		return <PreviewLoading />
	}

	if (load !== null && load.status !== "ready") {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t(STATE_MESSAGES[load.status])}
				secondary={source}
			/>
		)
	}

	// Open by default once there is more than one layer to choose from.
	const panelOpen = load !== null && (panel ?? load.layers.length + load.moreLayers > 1)
	const notices = [
		...(load?.missingGlyphs === true ? [t("previewCadMissingGlyphs")] : []),
		...(load !== null && load.skipped > 0 ? [t("previewCadSkipped", { count: load.skipped })] : [])
	]

	// The canvas is up while the drawing loads: the worker builds its renderer on it first.
	return (
		<div className="relative size-full">
			<CanvasViewerShell<DxfShellStatus>
				item={item}
				session={generation}
				label={t("previewCadCanvasLabel")}
				connect={port => {
					owned.run(remote => remote.attach(Comlink.transfer(port, [port]))).catch(() => undefined)
				}}
				// The only status: a display that did not come back.
				onStatus={restartLost}
				onReload={restart}
				notice={
					notices.length > 0 ? (
						<span className="rounded-md bg-background/80 px-2 py-1 text-muted-foreground">{notices.join(" ")}</span>
					) : undefined
				}
				sidePanel={
					load !== null && panelOpen ? (
						<LayersPanel
							layers={load.layers}
							more={load.moreLayers}
							hidden={hiddenNames}
							onToggle={(name, visible) => {
								const names = new Set(hiddenNames)

								if (visible) names.delete(name)
								else names.add(name)

								setHidden({ owner: owned, names })
								void owned.run(remote => remote.showLayer(name, visible)).catch(() => undefined)
							}}
						/>
					) : undefined
				}
				toolbar={
					load === null ? undefined : (
						<div className="flex flex-wrap justify-center gap-1 rounded-xl bg-background/80 p-1 shadow-sm">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									owned.run(remote => remote.fit()).catch(() => undefined)
								}}
							>
								<MaximizeIcon data-icon="inline-start" />
								{t("previewCadFit")}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								aria-pressed={dark}
								onClick={() => {
									setDark(!dark)
									void owned.run(remote => remote.background(!dark)).catch(() => undefined)
								}}
							>
								<MoonIcon data-icon="inline-start" />
								{t("previewCadDarkBackground")}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={onSource}
							>
								<CodeIcon data-icon="inline-start" />
								{t("previewCadShowSource")}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								aria-pressed={panelOpen}
								onClick={() => {
									setPanel(!panelOpen)
								}}
							>
								<LayersIcon data-icon="inline-start" />
								{t("previewCadLayers")}
							</Button>
						</div>
					)
				}
			/>
			{load === null ? (
				<div className="absolute inset-0 bg-background">
					<PreviewLoading />
				</div>
			) : null}
		</div>
	)
}

// A DXF drawing, built and drawn in a worker (pan, zoom, layers, a light or dark background), from the file alone: no
// request but the bundled fonts. Its source is a button away.
export function DxfViewer({ item }: { item: DriveItem }) {
	const { t } = useTranslation("preview")
	const result = usePreviewBytes(item)
	const [source, setSource] = useState(false)

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
						<PencilRulerIcon data-icon="inline-start" />
						{t("previewCadShowDrawing")}
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
				<DxfDrawing
					item={item}
					bytes={ready.bytes}
					onSource={() => {
						setSource(true)
					}}
				/>
			)}
		</PreviewGate>
	)
}
