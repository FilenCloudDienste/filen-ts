// The message loop of the FFmpeg audio decoders worker, appended after the Emscripten module by
// build-ffmpeg-decoders.sh (--extern-post-js). One worker serves every open decoder; requests are answered
// in the order they arrive.
//
//   { id, type: "open", codec, extradata?, stream? }             -> { id, handle }   (codec: a CODECS key)
//   { id, type: "decode", handle, data, timestampUs }           -> { id, frames }
//   { id, type: "flush", handle }                                -> { id, frames }
//   { id, type: "close", handle }                                -> { id }
//   { id, type: "log-level", level }                             -> { id }   (debugging; an AV_LOG_* level)
//
// A frame is { data, format, channels, channelMask, sampleRate, frames, timestampUs }: `format` is an
// AudioSampleFormat, planar data holds one plane after another, `channelMask` is the AV_CH_* mask of the
// planes (-1 when unknown), and every `data` buffer is transferred. A failure answers { id, error }. A trap
// in the WebAssembly module leaves it unusable for every decoder, so it answers { id, fatal } and the
// worker closes itself.
/* global createFfmpegDecoders */
;(() => {
	"use strict"

	const CODECS = {
		ac3: 0,
		eac3: 1,
		dts: 2,
		truehd: 3,
		alac: 4,
		flac: 5,
		wmav1: 6,
		wmav2: 7,
		wmapro: 8,
		wmalossless: 9,
		mp1: 10,
		mp2: 11,
		amrnb: 12,
		amrwb: 13,
		adpcm_ms: 14,
		adpcm_ima_wav: 15
	}
	// Indexed by AVSampleFormat: [AudioSampleFormat, bytes per sample, planar]. Doubles and 64-bit integers
	// have no AudioSampleFormat, and none of these decoders produces them.
	const FORMATS = [
		["u8", 1, false],
		["s16", 2, false],
		["s32", 4, false],
		["f32", 4, false],
		null,
		["u8-planar", 1, true],
		["s16-planar", 2, true],
		["s32-planar", 4, true],
		["f32-planar", 4, true]
	]
	const RESULT_DONE = 1
	const RESULT_SKIPPED = 2

	let modulePromise = null
	let dead = false

	function receiveAll(module, handle) {
		const frames = []
		const transfer = []

		for (;;) {
			const ret = module._decoder_receive(handle)

			if (ret === RESULT_DONE) {
				return { frames, transfer }
			}

			if (ret < 0) {
				throw new Error(`FFmpeg decoding failed (${String(ret)})`)
			}

			const format = FORMATS[module._decoder_format(handle)]

			if (format === undefined || format === null) {
				throw new Error(`unsupported FFmpeg sample format ${String(module._decoder_format(handle))}`)
			}

			const [name, bytes, planar] = format
			const channels = module._decoder_channels(handle)
			const count = module._decoder_frames(handle)
			const heap = module.HEAPU8
			let data

			if (planar) {
				const size = count * bytes

				data = new Uint8Array(size * channels)

				for (let channel = 0; channel < channels; channel++) {
					const pointer = module._decoder_plane(handle, channel)

					data.set(heap.subarray(pointer, pointer + size), channel * size)
				}
			} else {
				const pointer = module._decoder_plane(handle, 0)

				data = heap.slice(pointer, pointer + count * bytes * channels)
			}

			frames.push({
				data: data.buffer,
				format: name,
				channels,
				channelMask: module._decoder_channel_mask(handle),
				sampleRate: module._decoder_sample_rate(handle),
				frames: count,
				timestampUs: module._decoder_timestamp(handle)
			})
			transfer.push(data.buffer)
		}
	}

	async function handle(request) {
		modulePromise ??= createFfmpegDecoders()

		const module = await modulePromise

		switch (request.type) {
			case "open": {
				if (!Object.hasOwn(CODECS, request.codec)) {
					throw new Error(`no FFmpeg decoder for ${String(request.codec)}`)
				}

				// The codec configuration (ALAC's magic cookie, a WAVEFORMATEX's extra bytes), copied into a buffer the
				// decoder then owns; an empty one is none.
				const config = request.extradata === undefined || request.extradata.byteLength === 0 ? null : new Uint8Array(request.extradata)
				const extradata = config === null ? 0 : module._decoder_extradata(config.length)

				if (config !== null) {
					if (extradata === 0) {
						throw new Error("out of memory for an FFmpeg codec configuration")
					}

					module.HEAPU8.set(config, extradata)
				}

				// The stream's WAVEFORMATEX fields: { blockAlign, bitRate, sampleRate, channels, bitsPerSample }, 0 for none.
				const stream = request.stream ?? {}
				const field = value => (Number.isInteger(value) && value > 0 && value < 0x7fffffff ? value : 0)
				const handle = module._decoder_open(
					CODECS[request.codec],
					extradata,
					config === null ? 0 : config.length,
					field(stream.blockAlign),
					field(stream.bitRate),
					field(stream.sampleRate),
					field(stream.channels),
					field(stream.bitsPerSample)
				)

				if (handle === 0) {
					throw new Error(`cannot open an FFmpeg ${request.codec} decoder`)
				}

				return { response: { handle }, transfer: [] }
			}
			case "decode": {
				const bytes = new Uint8Array(request.data)
				const pointer = module._decoder_packet(request.handle, bytes.length)

				if (pointer === 0) {
					throw new Error("out of memory for an FFmpeg packet")
				}

				module.HEAPU8.set(bytes, pointer)

				const ret = module._decoder_send(request.handle, request.timestampUs)

				if (ret === RESULT_SKIPPED) {
					return { response: { frames: [] }, transfer: [] }
				}

				if (ret < 0) {
					throw new Error(`FFmpeg decoding failed (${String(ret)})`)
				}

				const { frames, transfer } = receiveAll(module, request.handle)

				return { response: { frames }, transfer }
			}
			case "flush": {
				const ret = module._decoder_drain(request.handle)

				if (ret < 0) {
					throw new Error(`FFmpeg flush failed (${String(ret)})`)
				}

				const { frames, transfer } = receiveAll(module, request.handle)

				module._decoder_reset(request.handle)

				return { response: { frames }, transfer }
			}
			case "close": {
				module._decoder_close(request.handle)

				return { response: {}, transfer: [] }
			}
			case "log-level": {
				module._decoder_log_level(request.level)

				return { response: {}, transfer: [] }
			}
			default:
				throw new Error(`unknown request ${String(request.type)}`)
		}
	}

	self.addEventListener("message", event => {
		const request = event.data

		if (dead) {
			return
		}

		handle(request).then(
			({ response, transfer }) => {
				self.postMessage({ id: request.id, ...response }, transfer)
			},
			error => {
				const message = error instanceof Error ? error.message : String(error)

				// A trap or an Emscripten abort leaves the module's memory in any state; a module that failed to
				// compile or link never works.
				if (
					error instanceof WebAssembly.RuntimeError ||
					error instanceof WebAssembly.CompileError ||
					error instanceof WebAssembly.LinkError
				) {
					dead = true
					self.postMessage({ id: request.id, fatal: message })
					self.close()
				} else {
					self.postMessage({ id: request.id, error: message })
				}
			}
		)
	})

	// Firefox shuts down an idle worker nested in another worker, leaving the next request unanswered;
	// a pending timer keeps it alive (https://github.com/Vanilagy/mediabunny/issues/435).
	setInterval(() => {}, 1000)
})()
