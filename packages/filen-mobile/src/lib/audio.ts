import { createAudioPlayer, setAudioModeAsync, type AudioStatus } from "expo-audio"
import audioCache, { type Metadata } from "@/lib/audioCache"
import type { DriveItemFileExtracted } from "@/types"
import * as FileSystem from "expo-file-system"
import { useEffect, useState } from "react"
import alerts from "@/lib/alerts"
import events from "@/lib/events"
import { Semaphore, run } from "@filen/utils"

export type QueueItem = {
	item: DriveItemFileExtracted
	audio: FileSystem.File
	metadata: Metadata
}

export type LoopMode = "none" | "track" | "queue"

export type Mode = "queue" | "preview"

export class Audio {
	// Two separate players — they never interfere with each other
	private readonly playlistPlayer = createAudioPlayer(undefined, {
		updateInterval: 500,
		crossOrigin: "anonymous"
	})
	private readonly previewPlayer = createAudioPlayer(undefined, {
		updateInterval: 500,
		crossOrigin: "anonymous"
	})

	// Queue/playlist state
	private queue: QueueItem[] = []
	private queuePosition = 0
	private loopMode: LoopMode = "none"
	private shuffled = false
	private shuffleOrder: number[] = []

	// Mode tracking
	private mode: Mode = "queue"
	private previewItem: DriveItemFileExtracted | null = null
	private loading = false

	// Concurrency control
	private operationId = 0
	private readonly previewMutex = new Semaphore(1)
	private readonly queueMutex = new Semaphore(1)

	public constructor() {
		setAudioModeAsync({
			interruptionMode: "doNotMix",
			playsInSilentMode: true,
			allowsRecording: false,
			shouldPlayInBackground: true,
			shouldRouteThroughEarpiece: false,
			allowsBackgroundRecording: false
		}).catch(console.error)

		this.playlistPlayer.addListener("playbackStatusUpdate", status => {
			events.emit("audioStatus", {
				mode: "queue",
				status
			})

			if (status.didJustFinish && this.mode === "queue") {
				this.handlePlaylistTrackEnd()
			}
		})

		this.previewPlayer.addListener("playbackStatusUpdate", status => {
			events.emit("audioStatus", {
				mode: "preview",
				status
			})
		})
	}

	private handlePlaylistTrackEnd(): void {
		// Native player.loop handles track looping — this guard is defensive
		// in case didJustFinish fires despite loop being on
		if (this.loopMode === "track") {
			return
		}

		const nextIndex = this.getNextIndex()

		if (nextIndex === null) {
			if (this.loopMode === "queue" && this.queue.length > 0) {
				this.queuePosition = 0

				this.loadAndPlay(this.getEffectiveIndex(0))

				return
			}

			this.playlistPlayer.pause()

			return
		}

		this.queuePosition = nextIndex

		this.loadAndPlay(this.getEffectiveIndex(nextIndex))
	}

	private getEffectiveIndex(position: number): number {
		if (this.shuffled && this.shuffleOrder.length > 0) {
			return this.shuffleOrder[position] ?? position
		}

		return position
	}

	private getNextIndex(): number | null {
		const next = this.queuePosition + 1

		if (next >= this.queue.length) {
			return null
		}

		return next
	}

	private getPreviousIndex(): number | null {
		const prev = this.queuePosition - 1

		if (prev < 0) {
			return null
		}

		return prev
	}

	private setLoading(value: boolean): void {
		if (this.loading === value) {
			return
		}

		this.loading = value

		events.emit("audioLoading", value)
	}

	private trackName(item: DriveItemFileExtracted, metadata: Metadata): string {
		return metadata?.title ?? FileSystem.Paths.parse(item.data.decryptedMeta?.name ?? item.data.uuid).name
	}

	private loadAndPlay(queueIndex: number): void {
		const entry = this.queue[queueIndex]

		if (!entry) {
			return
		}

		this.playlistPlayer.replace({
			uri: entry.audio.uri,
			name: this.trackName(entry.item, entry.metadata)
		})

		this.playlistPlayer.play()
		this.updatePlaylistLockScreen(entry)
	}

	private loadWithoutPlaying(queueIndex: number): void {
		const entry = this.queue[queueIndex]

		if (!entry) {
			return
		}

		this.playlistPlayer.replace({
			uri: entry.audio.uri,
			name: this.trackName(entry.item, entry.metadata)
		})

		this.updatePlaylistLockScreen(entry)
	}

	private updatePlaylistLockScreen(entry: QueueItem): void {
		this.playlistPlayer.setActiveForLockScreen(
			true,
			{
				title: this.trackName(entry.item, entry.metadata),
				artist: entry.metadata?.artist ?? undefined,
				albumTitle: entry.metadata?.album ?? undefined
			},
			{
				showSeekBackward: true,
				showSeekForward: true
			}
		)
	}

	private generateShuffleOrder(): void {
		const length = this.queue.length

		this.shuffleOrder = new Array<number>(length)

		for (let i = 0; i < length; i++) {
			this.shuffleOrder[i] = i
		}

		const currentEffective = this.getEffectiveIndex(this.queuePosition)

		// Fisher-Yates shuffle
		for (let i = length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1))
			const a = this.shuffleOrder[i] ?? i
			const b = this.shuffleOrder[j] ?? j

			this.shuffleOrder[i] = b
			this.shuffleOrder[j] = a
		}

		// Move the current track to position 0 so it doesn't restart
		const currentShufflePos = this.shuffleOrder.indexOf(currentEffective)

		if (currentShufflePos > 0) {
			const a = this.shuffleOrder[0] ?? 0
			const b = this.shuffleOrder[currentShufflePos] ?? currentShufflePos

			this.shuffleOrder[0] = b
			this.shuffleOrder[currentShufflePos] = a
		}

		this.queuePosition = 0
	}

	// ──────────────────────────────────────────────
	// Queue/playlist mode — public API
	// ──────────────────────────────────────────────

	public async addToQueue({ item, position = "end" }: { item: DriveItemFileExtracted; position?: "start" | "end" }): Promise<void> {
		await run(
			async defer => {
				const myOp = this.operationId

				await this.queueMutex.acquire()

				defer(() => {
					this.setLoading(false)
					this.queueMutex.release()
				})

				this.setLoading(true)

				const { audio, metadata } = await audioCache.get({
					item
				})

				if (this.operationId !== myOp) {
					return
				}

				const queueItem: QueueItem = {
					item,
					audio,
					metadata
				}

				if (position === "start") {
					this.queue.unshift(queueItem)

					if (this.queue.length > 1) {
						this.queuePosition++
					}
				} else {
					this.queue.push(queueItem)
				}
			},
			{
				throw: true
			}
		)
	}

	public removeFromQueue(index: number): void {
		if (index < 0 || index >= this.queue.length) {
			return
		}

		this.queue.splice(index, 1)

		if (index < this.queuePosition) {
			this.queuePosition--
		} else if (index === this.queuePosition) {
			if (this.queuePosition >= this.queue.length) {
				this.queuePosition = Math.max(0, this.queue.length - 1)
			}

			if (this.queue.length > 0) {
				this.loadWithoutPlaying(this.getEffectiveIndex(this.queuePosition))
			} else {
				this.stopPlaylist()
			}
		}
	}

	public clearQueue(): void {
		this.operationId++

		this.queue = []
		this.queuePosition = 0
		this.shuffleOrder = []
		this.playlistPlayer.pause()
		this.playlistPlayer.clearLockScreenControls()
	}

	public async play(item?: DriveItemFileExtracted): Promise<void> {
		await run(
			async defer => {
				const myOp = this.operationId

				await this.queueMutex.acquire()

				defer(() => {
					this.setLoading(false)
					this.queueMutex.release()
				})

				if (item) {
					this.setLoading(true)

					const { audio, metadata } = await audioCache.get({
						item
					})

					if (this.operationId !== myOp) {
						return
					}

					const queueItem: QueueItem = {
						item,
						audio,
						metadata
					}

					this.queue.unshift(queueItem)

					this.queuePosition = 0

					this.loadAndPlay(this.getEffectiveIndex(0))

					return
				}

				if (this.playlistPlayer.paused && this.playlistPlayer.isLoaded && this.queue.length > 0) {
					this.playlistPlayer.play()

					return
				}

				if (this.queue.length > 0) {
					this.loadAndPlay(this.getEffectiveIndex(this.queuePosition))
				}
			},
			{
				throw: true
			}
		)
	}

	public pausePlaylist(): void {
		this.playlistPlayer.pause()
	}

	public resumePlaylist(): void {
		if (this.queue.length > 0) {
			this.playlistPlayer.play()
		}
	}

	public next(): void {
		this.operationId++

		const nextIndex = this.getNextIndex()

		if (nextIndex === null) {
			if (this.loopMode === "queue" && this.queue.length > 0) {
				this.queuePosition = 0

				this.loadAndPlay(this.getEffectiveIndex(0))

				return
			}

			return
		}

		this.queuePosition = nextIndex

		this.loadAndPlay(this.getEffectiveIndex(nextIndex))
	}

	public previous(): void {
		this.operationId++

		// If more than 3 seconds in, restart the current track instead of going back
		if (this.playlistPlayer.currentTime > 3) {
			this.playlistPlayer.seekTo(0)

			return
		}

		const prevIndex = this.getPreviousIndex()

		if (prevIndex === null) {
			if (this.loopMode === "queue" && this.queue.length > 0) {
				this.queuePosition = this.queue.length - 1

				this.loadAndPlay(this.getEffectiveIndex(this.queuePosition))

				return
			}

			this.playlistPlayer.seekTo(0)

			return
		}

		this.queuePosition = prevIndex

		this.loadAndPlay(this.getEffectiveIndex(prevIndex))
	}

	public seekPlaylist(seconds: number): void {
		this.playlistPlayer.seekTo(seconds)
	}

	public stopPlaylist(): void {
		this.operationId++

		this.playlistPlayer.pause()
		this.playlistPlayer.seekTo(0)
		this.playlistPlayer.clearLockScreenControls()
	}

	public setLoopMode(mode: LoopMode): void {
		this.loopMode = mode
		this.playlistPlayer.loop = mode === "track"
	}

	public toggleShuffle(): void {
		this.shuffled = !this.shuffled

		if (this.shuffled) {
			this.generateShuffleOrder()
		} else {
			const realIndex = this.getEffectiveIndex(this.queuePosition)

			this.shuffleOrder = []
			this.queuePosition = realIndex
		}
	}

	public skipTo(index: number): void {
		if (index < 0 || index >= this.queue.length) {
			return
		}

		this.operationId++
		this.queuePosition = index

		this.loadAndPlay(this.getEffectiveIndex(index))
	}

	// ──────────────────────────────────────────────
	// Preview mode — public API
	// ──────────────────────────────────────────────

	public async enterPreviewMode({ item, autoPlay = false }: { item: DriveItemFileExtracted; autoPlay?: boolean }): Promise<void> {
		await run(
			async defer => {
				const myOp = ++this.operationId

				await this.previewMutex.acquire()

				defer(() => {
					this.setLoading(false)
					this.previewMutex.release()
				})

				this.playlistPlayer.pause()

				this.mode = "preview"
				this.previewItem = item
				this.setLoading(true)

				const { audio, metadata } = await audioCache.get({
					item
				})

				if (this.operationId !== myOp) {
					return
				}

				this.previewPlayer.replace({
					uri: audio.uri,
					name: this.trackName(item, metadata)
				})

				if (autoPlay) {
					this.previewPlayer.play()
				}
			},
			{
				throw: true
			}
		)
	}

	public async switchPreviewTrack({ item }: { item: DriveItemFileExtracted }): Promise<void> {
		await run(
			async defer => {
				const myOp = ++this.operationId

				await this.previewMutex.acquire()

				defer(() => {
					this.setLoading(false)
					this.previewMutex.release()
				})

				this.previewPlayer.pause()

				this.previewItem = item
				this.setLoading(true)

				const { audio, metadata } = await audioCache.get({
					item
				})

				if (this.operationId !== myOp) {
					return
				}

				this.previewPlayer.replace({
					uri: audio.uri,
					name: this.trackName(item, metadata)
				})
			},
			{
				throw: true
			}
		)
	}

	public pausePreview(): void {
		this.previewPlayer.pause()
	}

	public resumePreview(): void {
		this.previewPlayer.play()
	}

	public seekPreview(seconds: number): void {
		this.previewPlayer.seekTo(seconds)
	}

	public exitPreviewMode(): void {
		this.operationId++

		this.previewPlayer.pause()
		this.previewPlayer.seekTo(0)

		this.mode = "queue"
		this.previewItem = null
	}

	// ──────────────────────────────────────────────
	// Getters
	// ──────────────────────────────────────────────

	public getMode(): Mode {
		return this.mode
	}

	public getQueue(): readonly QueueItem[] {
		return this.queue
	}

	public getQueuePosition(): number {
		return this.queuePosition
	}

	public getCurrentQueueItem(): QueueItem | null {
		return this.queue[this.getEffectiveIndex(this.queuePosition)] ?? null
	}

	public getPreviewItem(): DriveItemFileExtracted | null {
		return this.previewItem
	}

	public getLoopMode(): LoopMode {
		return this.loopMode
	}

	public isShuffled(): boolean {
		return this.shuffled
	}

	public isLoading(): boolean {
		return this.loading
	}
}

const audio = new Audio()

export function useAudio() {
	const [status, setStatus] = useState<Record<Mode, AudioStatus | null>>({
		queue: null,
		preview: null
	})
	const [loading, setLoadingState] = useState<boolean>(false)

	const play = (item?: DriveItemFileExtracted) => {
		audio.play(item).catch(err => {
			console.error(err)
			alerts.error(err)
		})
	}

	const pausePlaylist = () => {
		audio.pausePlaylist()
	}

	const resumePlaylist = () => {
		audio.resumePlaylist()
	}

	const next = () => {
		audio.next()
	}

	const previous = () => {
		audio.previous()
	}

	const seekPlaylist = (seconds: number) => {
		audio.seekPlaylist(seconds)
	}

	const addToQueue = (params: Parameters<typeof audio.addToQueue>[0]) => {
		audio.addToQueue(params).catch(err => {
			console.error(err)
			alerts.error(err)
		})
	}

	const removeFromQueue = (index: number) => {
		audio.removeFromQueue(index)
	}

	const clearQueue = () => {
		audio.clearQueue()
	}

	const setLoopMode = (mode: LoopMode) => {
		audio.setLoopMode(mode)
	}

	const toggleShuffle = () => {
		audio.toggleShuffle()
	}

	const skipTo = (index: number) => {
		audio.skipTo(index)
	}

	const stopPlaylist = () => {
		audio.stopPlaylist()
	}

	const enterPreviewMode = (params: Parameters<typeof audio.enterPreviewMode>[0]) => {
		audio.enterPreviewMode(params).catch(err => {
			console.error(err)
			alerts.error(err)
		})
	}

	const switchPreviewTrack = (params: Parameters<typeof audio.switchPreviewTrack>[0]) => {
		audio.switchPreviewTrack(params).catch(err => {
			console.error(err)
			alerts.error(err)
		})
	}

	const pausePreview = () => {
		audio.pausePreview()
	}

	const resumePreview = () => {
		audio.resumePreview()
	}

	const seekPreview = (seconds: number) => {
		audio.seekPreview(seconds)
	}

	const exitPreviewMode = () => {
		audio.exitPreviewMode()
	}

	useEffect(() => {
		const statusSubscription = events.subscribe("audioStatus", info => {
			setStatus(prev => ({
				...prev,
				[info.mode]: info.status
			}))
		})

		const loadingSubscription = events.subscribe("audioLoading", setLoadingState)

		return () => {
			statusSubscription.remove()
			loadingSubscription.remove()
		}
	}, [])

	return {
		status,
		loading,
		mode: () => audio.getMode(),
		queue: () => audio.getQueue(),
		queuePosition: () => audio.getQueuePosition(),
		currentQueueItem: () => audio.getCurrentQueueItem(),
		previewItem: () => audio.getPreviewItem(),
		loopMode: () => audio.getLoopMode(),
		shuffled: () => audio.isShuffled(),
		play,
		pausePlaylist,
		resumePlaylist,
		next,
		previous,
		seekPlaylist,
		addToQueue,
		removeFromQueue,
		clearQueue,
		setLoopMode,
		toggleShuffle,
		skipTo,
		stopPlaylist,
		enterPreviewMode,
		switchPreviewTrack,
		pausePreview,
		resumePreview,
		seekPreview,
		exitPreviewMode
	}
}

export default audio
