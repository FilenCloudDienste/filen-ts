import { useEffect, useEffectEvent, useState } from "react"
import { useTranslation } from "react-i18next"
import * as Comlink from "comlink"
import { BoxIcon, ChevronDownIcon, CodeIcon, GridIcon, InfoIcon, MaximizeIcon, PlayIcon, RotateCcwIcon, SquareIcon } from "lucide-react"
import { driveItemName } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import { itemTypeExtension, TEXT_MAX_BYTES } from "@/features/drive/lib/preview.logic"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useOwnedWorker } from "@/lib/workers/ownedWorker"
import { useDeviceProfile } from "@/lib/useDeviceProfile"
import { workerDecodePixels } from "@/lib/pixelBudget"
import { getPreviewBytes } from "@/features/preview/lib/previewCache"
import { usePreviewAccessMode, usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { loadOriginBytes } from "@/features/preview/lib/origin/loadBytes"
import { usePreviewFetch } from "@/features/preview/hooks/usePreviewFetch"
import { usePreviewReferences, type ReferenceResolver } from "@/features/preview/lib/referenceResolver"
import { CanvasViewerShell } from "@/features/preview/components/canvasViewerShell"
import { MetadataCard } from "@/features/preview/components/metadataCard"
import { TextViewer } from "@/features/preview/components/textViewer"
import { PreviewGate, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import type { MetadataSectionData } from "@/features/preview/lib/metadataCard.types"
import { MODEL_MAX_BYTES, TEXTURE_BPP, isTextModel, modelFormat, type ModelFormat } from "@/features/preview/lib/model3d/preflight.logic"
import {
	animationEntries,
	referenceOutcomes,
	referenceSummary,
	type ReferenceOutcome
} from "@/features/preview/components/model3dViewer.logic"
import Model3dWorker from "@/features/preview/workers/model3d.worker.ts?worker"
import type { Model3dWorkerApi, ModelLoad } from "@/features/preview/workers/model3d.worker"

interface SceneLoad {
	readonly load: ModelLoad
	readonly references: readonly ReferenceOutcome[]
}

function createModelWorker(): Worker {
	return new Model3dWorker()
}

// One load per worker: an effect that runs twice (StrictMode) joins the first, whose bytes are already transferred.
const loads = new WeakMap<object, Promise<SceneLoad>>()

const FORMAT_LABELS: Record<ModelFormat, string> = {
	stl: "STL",
	obj: "Wavefront OBJ",
	gltf: "glTF",
	glb: "glTF binary",
	"3mf": "3MF",
	fbx: "FBX",
	ply: "PLY",
	usdz: "USDZ"
}

// Serves the worker's references through the surface's resolver, every file within what the model left of the cap.
// Each outcome is recorded for the information panel.
function referenceServer(
	resolver: ReferenceResolver | null,
	budget: number,
	signal: AbortSignal,
	record: (outcome: ReferenceOutcome) => void
): (path: string) => Promise<Blob | null> {
	let left = budget

	return async path => {
		const found =
			resolver === null ? ({ status: "missing" } as const) : await resolver(path).catch(() => ({ status: "missing" }) as const)

		if (found.status !== "found") {
			record({ path, status: found.status })

			return null
		}

		if (found.size > left) {
			record({ path, status: "refused" })

			return null
		}

		const bytes = await found.read(left, signal).catch(() => null)

		if (bytes === null) {
			record({ path, status: "missing" })

			return null
		}

		left -= bytes.byteLength
		record({ path, status: "found" })

		return new Blob([bytes as Uint8Array<ArrayBuffer>])
	}
}

function InfoPanel({ item, scene }: { item: DriveItem; scene: SceneLoad }) {
	const { t } = useTranslation("preview")
	const { load, references } = scene
	const info = load.info
	const format = modelFormat(itemTypeExtension(item))
	const number = (value: number): string => t("previewModelCount", { value })
	const sections: MetadataSectionData[] = []

	if (info !== null) {
		const [x, y, z] = info.size

		sections.push({
			title: t("previewModelInfoModel"),
			fields: [
				{ label: t("previewModelInfoFormat"), value: format === null ? "" : FORMAT_LABELS[format] },
				{ label: t("previewModelInfoTriangles"), value: number(info.triangles) },
				{ label: t("previewModelInfoVertices"), value: number(info.vertices) },
				{ label: t("previewModelInfoMeshes"), value: number(info.meshes) },
				{ label: t("previewModelInfoMaterials"), value: number(info.materials) },
				{ label: t("previewModelInfoTextures"), value: number(info.textures) },
				{ label: t("previewModelInfoBounds"), value: [x, y, z].map(side => side.toPrecision(4)).join(" × ") }
			]
		})
	}

	const summary = referenceSummary(references)
	const fields = [
		...summary.missing.map(path => ({ label: t("previewModelInfoMissing"), value: path, mono: true })),
		...summary.unreadable.map(path => ({ label: t("previewModelInfoUnreadable"), value: path, mono: true })),
		...summary.refused.map(path => ({ label: t("previewModelInfoRefused"), value: path, mono: true })),
		...(load.blocked > 0 ? [{ label: t("previewModelInfoBlocked"), value: number(load.blocked) }] : []),
		...(load.skippedTextures > 0 ? [{ label: t("previewModelInfoSkipped"), value: number(load.skippedTextures) }] : [])
	]

	if (fields.length > 0) sections.push({ title: t("previewModelInfoReferences"), fields })

	return (
		<div className="p-3">
			<MetadataCard
				title={driveItemName(item)}
				sections={sections}
			/>
		</div>
	)
}

function AnimationControl({
	names,
	playing,
	onPlay
}: {
	names: readonly string[]
	playing: number | null
	onPlay: (index: number | null) => void
}) {
	const { t } = useTranslation("preview")

	if (names.length === 0) return null

	if (playing !== null) {
		return (
			<Button
				variant="ghost"
				size="sm"
				onClick={() => {
					onPlay(null)
				}}
			>
				<SquareIcon data-icon="inline-start" />
				{t("previewModelStop")}
			</Button>
		)
	}

	if (names.length === 1) {
		return (
			<Button
				variant="ghost"
				size="sm"
				onClick={() => {
					onPlay(0)
				}}
			>
				<PlayIcon data-icon="inline-start" />
				{t("previewModelPlay")}
			</Button>
		)
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="sm"
					/>
				}
			>
				<PlayIcon data-icon="inline-start" />
				{t("previewModelPlay")}
				<ChevronDownIcon data-icon="inline-end" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="center">
				{animationEntries(names).map(entry => (
					<DropdownMenuItem
						key={entry.key}
						onClick={() => {
							onPlay(entry.clip)
						}}
					>
						{entry.name ?? t("previewModelAnimation", { number: entry.clip + 1 })}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function ModelScene({
	item,
	bytes,
	format,
	keep,
	textual,
	onSource,
	onReread
}: {
	item: DriveItem
	bytes: Uint8Array
	format: ModelFormat
	// Whether the page keeps its own copy (the preview cache's): the worker then gets a copy, else the bytes themselves.
	keep: boolean
	textual: boolean
	onSource: () => void
	// Reads the file again (the worker took the only copy).
	onReread: () => void
}) {
	const { t } = useTranslation("preview")
	const profile = useDeviceProfile()
	const references = usePreviewReferences()
	const [attempt, setAttempt] = useState(0)
	const worker = useOwnedWorker<Model3dWorkerApi>(createModelWorker, `${item.data.uuid}:${String(attempt)}`, "model3d")
	const owned = worker.status === "ready" ? worker.owned : null
	const generation = worker.status === "ready" ? worker.generation : 0
	const [state, setState] = useState<{ owner: object; scene: SceneLoad | null } | null>(null)
	const scene = state !== null && state.owner === owned ? state.scene : null
	const [info, setInfo] = useState(false)
	const [wireframe, setWireframe] = useState(false)
	const [playing, setPlaying] = useState<number | null>(null)
	// A new worker for the display it lost: the page's copy, else the file read again.
	const onReload = (): void => {
		if (keep) setAttempt(previous => previous + 1)
		else onReread()
	}
	const start = useEffectEvent((target: NonNullable<typeof owned>): Promise<SceneLoad> => {
		const outcomes: ReferenceOutcome[] = []
		// Reference reads stop once the load is over, the worker gone included.
		const reads = new AbortController()
		const serve = referenceServer(references(item), MODEL_MAX_BYTES - bytes.byteLength, reads.signal, outcome => {
			outcomes.push(outcome)
		})
		const sent = keep ? bytes.slice() : bytes

		return target
			.run(remote =>
				remote.load(
					Comlink.transfer({ bytes: sent, format, texturePixels: workerDecodePixels(profile, bytes.byteLength, TEXTURE_BPP) }, [
						sent.buffer
					]),
					Comlink.proxy(serve)
				)
			)
			.then(load => ({ load, references: referenceOutcomes(outcomes) }))
			.finally(() => {
				reads.abort()
			})
	})

	useEffect(() => {
		if (owned === null) return

		let live = true
		const pending = loads.get(owned) ?? start(owned)

		loads.set(owned, pending)
		pending.then(
			loaded => {
				if (live) setState({ owner: owned, scene: loaded })
			},
			() => {
				if (live) setState({ owner: owned, scene: { load: FAILED, references: [] } })
			}
		)

		return () => {
			live = false
		}
	}, [owned])

	const source = textual ? (
		<Button
			variant="outline"
			onClick={onSource}
		>
			{t("previewModelShowSource")}
		</Button>
	) : undefined

	if (worker.status === "failed") {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewModelUnreadable")}
				secondary={source}
			/>
		)
	}

	if (owned === null) {
		return <PreviewLoading />
	}

	if (scene !== null && scene.load.status !== "ready") {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t(STATE_MESSAGES[scene.load.status])}
				secondary={source}
			/>
		)
	}

	const missing = referenceSummary(scene?.references ?? [])
	const notFound = missing.missing.length + missing.unreadable.length + missing.refused.length
	const toggle = (on: boolean): void => {
		setWireframe(on)
		void owned.run(remote => remote.wireframe(on)).catch(() => undefined)
	}

	const animations = scene?.load.animations ?? []

	// The canvas is up while the model loads: the worker builds its renderer on it before parsing.
	return (
		<div className="relative size-full">
			<CanvasViewerShell
				item={item}
				session={generation}
				label={t("previewModelCanvasLabel")}
				connect={port => {
					void owned.run(remote => remote.attach(Comlink.transfer(port, [port])))
				}}
				onReload={onReload}
				notice={
					notFound > 0 ? (
						<span className="rounded-md bg-background/80 px-2 py-1 text-muted-foreground">
							{t("previewModelReferencesMissing", { count: notFound })}
						</span>
					) : undefined
				}
				sidePanel={
					info && scene !== null ? (
						<InfoPanel
							item={item}
							scene={scene}
						/>
					) : undefined
				}
				toolbar={
					scene === null ? undefined : (
						<div className="flex flex-wrap justify-center gap-1 rounded-xl bg-background/80 p-1 shadow-sm">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									void owned.run(remote => remote.fit())
								}}
							>
								<MaximizeIcon data-icon="inline-start" />
								{t("previewModelFit")}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									void owned.run(remote => remote.reset())
								}}
							>
								<RotateCcwIcon data-icon="inline-start" />
								{t("previewModelReset")}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								aria-pressed={wireframe}
								onClick={() => {
									toggle(!wireframe)
								}}
							>
								<GridIcon data-icon="inline-start" />
								{t("previewModelWireframe")}
							</Button>
							<AnimationControl
								names={animations}
								playing={playing}
								onPlay={index => {
									setPlaying(index)
									void owned.run(remote => remote.play(index)).catch(() => undefined)
								}}
							/>
							{textual ? (
								<Button
									variant="ghost"
									size="sm"
									onClick={onSource}
								>
									<CodeIcon data-icon="inline-start" />
									{t("previewModelShowSource")}
								</Button>
							) : null}
							<Button
								variant="ghost"
								size="sm"
								aria-pressed={info}
								onClick={() => {
									setInfo(!info)
								}}
							>
								<InfoIcon data-icon="inline-start" />
								{t("previewModelInfo")}
							</Button>
						</div>
					)
				}
			/>
			{scene === null ? (
				<div className="absolute inset-0 bg-background">
					<PreviewLoading />
				</div>
			) : null}
		</div>
	)
}

const FAILED: ModelLoad = { status: "failed", info: null, animations: [], skippedTextures: 0, blocked: 0 }

const STATE_MESSAGES = {
	tooLarge: "previewModelTooLarge",
	malformed: "previewModelUnreadable",
	failed: "previewModelUnreadable",
	tooComplex: "previewModelTooComplex",
	noWebgl: "previewModelNoWebgl"
} as const

// A 3D model (STL, OBJ with its MTL, glTF, GLB, 3MF, FBX, PLY, USDZ), drawn in a worker with an orbit camera, only when
// something changed. Its referenced files come from its own directory and those below it. A text format's source is a
// button away.
export function Model3dViewer({ item }: { item: DriveItem }) {
	const { t } = useTranslation("preview")
	const format = modelFormat(itemTypeExtension(item))
	const origin = usePreviewOrigin(item)
	const access = usePreviewAccessMode()
	// A text format small enough for the text viewer stays in the preview cache, where View source finds it; anything
	// else is handed to the worker and not kept.
	const keep = (format === "obj" || format === "gltf" || format === "stl" || format === "ply") && item.data.size <= TEXT_MAX_BYTES
	const load = usePreviewFetch(item, {
		seed: (scope, uuid) => (keep ? getPreviewBytes(scope, uuid) : undefined),
		run: async ({ token, signal, cacheScope }) =>
			await loadOriginBytes(origin, token, { access, cap: MODEL_MAX_BYTES, store: keep, scope: cacheScope, signal })
	})
	const [source, setSource] = useState(false)

	if (format === null) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewModelUnreadable")}
			/>
		)
	}

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
						<BoxIcon data-icon="inline-start" />
						{t("previewModelShowModel")}
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
		<PreviewGate result={load}>
			{ready => (
				<ModelScene
					item={item}
					bytes={ready.value}
					format={format}
					keep={keep}
					// Kept bytes only (never handed over): an ASCII STL or PLY has a source to show, a binary one none.
					textual={keep && isTextModel(format, ready.value)}
					onSource={() => {
						setSource(true)
					}}
					onReread={ready.refetch}
				/>
			)}
		</PreviewGate>
	)
}
