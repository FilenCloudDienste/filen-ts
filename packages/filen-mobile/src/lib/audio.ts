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

export class Audio {
	private readonly player = createAudioPlayer(undefined, {
		updateInterval: 1000,
		crossOrigin: "anonymous"
	})
	private queue: QueueItem[] = []
	private queuePosition = 0
	private loopMode: LoopMode = "none"
	private shuffled = false
	private shuffleOrder: number[] = []
	private loading = false
	private readonly queueMutex = new Semaphore(1)

	public constructor() {
		this.setAudioMode()

		this.player.addListener("playbackStatusUpdate", status => {
			events.emit("audioStatus", status)

			if (status.didJustFinish) {
				this.handleTrackEnd()
			}
		})
	}

	public setAudioMode(): void {
		run(async () => {
			await setAudioModeAsync({
				interruptionMode: "doNotMix",
				playsInSilentMode: true,
				allowsRecording: false,
				shouldPlayInBackground: true,
				shouldRouteThroughEarpiece: false,
				allowsBackgroundRecording: false
			})
		})
	}

	private handleTrackEnd(): void {
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

			this.player.pause()

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

		this.player.replace({
			uri: entry.audio.uri,
			name: this.trackName(entry.item, entry.metadata)
		})

		this.player.play()
		this.updateLockScreen(entry)
	}

	private loadWithoutPlaying(queueIndex: number): void {
		const entry = this.queue[queueIndex]

		if (!entry) {
			return
		}

		this.player.replace({
			uri: entry.audio.uri,
			name: this.trackName(entry.item, entry.metadata)
		})

		this.updateLockScreen(entry)
	}

	private updateLockScreen(entry: QueueItem): void {
		this.player.setActiveForLockScreen(
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

	public async addToQueue({ item, position = "end" }: { item: DriveItemFileExtracted; position?: "start" | "end" }): Promise<void> {
		await run(
			async defer => {
				await this.queueMutex.acquire()

				defer(() => {
					this.setLoading(false)
					this.queueMutex.release()
				})

				this.setLoading(true)

				const { audio, metadata } = await audioCache.get({
					item: {
						type: "drive",
						data: item
					}
				})

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
				this.stop()
			}
		}
	}

	public clearQueue(): void {
		this.queue = []
		this.queuePosition = 0
		this.shuffleOrder = []
		this.player.pause()
		this.player.clearLockScreenControls()
	}

	public async play(item?: DriveItemFileExtracted): Promise<void> {
		await run(
			async defer => {
				await this.queueMutex.acquire()

				defer(() => {
					this.setLoading(false)
					this.queueMutex.release()
				})

				if (item) {
					this.setLoading(true)

					const { audio, metadata } = await audioCache.get({
						item: {
							type: "drive",
							data: item
						}
					})

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

				if (this.player.paused && this.player.isLoaded && this.queue.length > 0) {
					this.player.play()

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

	public pause(): void {
		this.player.pause()
	}

	public resume(): void {
		if (this.queue.length > 0) {
			this.player.play()
		}
	}

	public next(): void {
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
		// If more than 3 seconds in, restart the current track instead of going back
		if (this.player.currentTime > 3) {
			this.player.seekTo(0)

			return
		}

		const prevIndex = this.getPreviousIndex()

		if (prevIndex === null) {
			if (this.loopMode === "queue" && this.queue.length > 0) {
				this.queuePosition = this.queue.length - 1

				this.loadAndPlay(this.getEffectiveIndex(this.queuePosition))

				return
			}

			this.player.seekTo(0)

			return
		}

		this.queuePosition = prevIndex

		this.loadAndPlay(this.getEffectiveIndex(prevIndex))
	}

	public seek(seconds: number): void {
		this.player.seekTo(seconds)
	}

	public stop(): void {
		this.player.pause()
		this.player.seekTo(0)
		this.player.clearLockScreenControls()
	}

	public setLoopMode(mode: LoopMode): void {
		this.loopMode = mode
		this.player.loop = mode === "track"
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

		this.queuePosition = index

		this.loadAndPlay(this.getEffectiveIndex(index))
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
	const [status, setStatus] = useState<AudioStatus | null>(null)
	const [loading, setLoadingState] = useState<boolean>(false)

	const play = (item?: DriveItemFileExtracted) => {
		audio.play(item).catch(err => {
			console.error(err)
			alerts.error(err)
		})
	}

	const pause = () => {
		audio.pause()
	}

	const resume = () => {
		audio.resume()
	}

	const next = () => {
		audio.next()
	}

	const previous = () => {
		audio.previous()
	}

	const seek = (seconds: number) => {
		audio.seek(seconds)
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

	const stop = () => {
		audio.stop()
	}

	useEffect(() => {
		const statusSubscription = events.subscribe("audioStatus", setStatus)
		const loadingSubscription = events.subscribe("audioLoading", setLoadingState)

		return () => {
			statusSubscription.remove()
			loadingSubscription.remove()
		}
	}, [])

	return {
		status,
		loading,
		queue: () => audio.getQueue(),
		queuePosition: () => audio.getQueuePosition(),
		currentQueueItem: () => audio.getCurrentQueueItem(),
		loopMode: () => audio.getLoopMode(),
		shuffled: () => audio.isShuffled(),
		play,
		pause,
		resume,
		next,
		previous,
		seek,
		addToQueue,
		removeFromQueue,
		clearQueue,
		setLoopMode,
		toggleShuffle,
		skipTo,
		stop
	}
}

export default audio
