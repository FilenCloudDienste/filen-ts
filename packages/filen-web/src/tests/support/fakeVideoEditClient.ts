import { vi } from "vitest"
import type {
	VideoSaveOutcome,
	ExportPlan,
	ExportProgress,
	VideoEditClient,
	VideoEditRecipe,
	VideoSaveTarget,
	VideoSourceInfo
} from "@/features/preview/videoEdit/types"

// A VideoEditClient for the editor's tests: no worker, no decoding. Frames and thumbnails are tiny closable stand-ins,
// plan() answers with `plan` (patched per recipe by `planFor` when given), and each export is held open until the test
// reports progress on it or settles it.

export const FAKE_INFO: VideoSourceInfo = {
	duration: 100,
	width: 1920,
	height: 1080,
	codedWidth: 1920,
	codedHeight: 1080,
	rotation: 0,
	frameRate: 25,
	videoCodec: "avc1.640028",
	transfer: "sdr",
	bitDepth: 8,
	keyframes: new Float64Array([0, 2, 4, 6, 8, 10]),
	audio: [{ number: 1, codec: "mp4a.40.2", channels: 2, language: null }],
	container: "mp4",
	hasSubtitles: false,
	hasChapters: false,
	hasLocation: false,
	bytes: 50_000_000,
	previewable: true
}

export const FAKE_PLAN: ExportPlan = {
	mode: "copy",
	transcodeReasons: [],
	unavailable: [],
	blockers: [],
	mutingUnblocks: false,
	dropped: [],
	hdr: null,
	container: "mp4",
	targets: ["inPlace", "copy"],
	estimateBytes: 40_000_000,
	estimateSeconds: 30,
	snapped: [],
	outputDuration: 100
}

export interface FakeExport {
	recipe: VideoEditRecipe
	target: VideoSaveTarget
	progress: (progress: ExportProgress) => void
	settle: (outcome: VideoSaveOutcome) => void
	cancel: ReturnType<typeof vi.fn>
	detachToTransfer: ReturnType<typeof vi.fn>
}

export function fakeBitmap(width = 160, height = 90): ImageBitmap {
	const bitmap: ImageBitmap = { width, height, close: vi.fn() }

	return bitmap
}

export function fakeVideoEditClient(
	options: { info?: Partial<VideoSourceInfo>; planFor?: (recipe: VideoEditRecipe) => Partial<ExportPlan> } = {}
) {
	const info: VideoSourceInfo = { ...FAKE_INFO, ...options.info }
	const exports: FakeExport[] = []
	const plans: VideoEditRecipe[] = []
	const client = {
		loadSource: vi.fn(() => Promise.resolve(info)),
		frameAt: vi.fn((_time: number, _recipe: VideoEditRecipe, _maxWidth: number) => Promise.resolve(fakeBitmap())),
		filterThumbnails: vi.fn((_time: number, _recipe: VideoEditRecipe, filters: readonly (string | null)[], _height: number) =>
			Promise.resolve(filters.map(filter => ({ filter, bitmap: fakeBitmap() })))
		),
		filmstrip: vi.fn((times: readonly number[], _height: number) =>
			Promise.resolve(times.map(time => ({ time, bitmap: fakeBitmap() })))
		),
		isDecodingSuspended: vi.fn(() => false),
		onDecodingSuspendedChange: vi.fn((_listener: (suspended: boolean) => void) => vi.fn()),
		waveform: vi.fn((_range: { start: number; end: number }, columns: number, onUpdate: (peaks: Float32Array) => void) => {
			onUpdate(new Float32Array(columns).fill(Number.NaN))

			return vi.fn()
		}),
		plan: vi.fn((recipe: VideoEditRecipe) => {
			plans.push(recipe)

			return Promise.resolve({ ...FAKE_PLAN, ...options.planFor?.(recipe) })
		}),
		exportVideo: vi.fn((recipe: VideoEditRecipe, target: VideoSaveTarget, onProgress: (progress: ExportProgress) => void) => {
			let settle: (outcome: VideoSaveOutcome) => void = () => undefined
			const done = new Promise<VideoSaveOutcome>(resolve => {
				settle = resolve
			})
			const cancel = vi.fn(() => {
				settle({ status: "cancelled" })
			})
			const detachToTransfer = vi.fn()

			exports.push({
				recipe,
				target,
				progress: onProgress,
				settle: outcome => {
					settle(outcome)
				},
				cancel,
				detachToTransfer
			})

			return { done, cancel, detachToTransfer }
		}),
		dispose: vi.fn()
	} satisfies VideoEditClient

	return { client, info, exports, plans }
}
