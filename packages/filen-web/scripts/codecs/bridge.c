// The C side of the FFmpeg audio decoders module: a thin handle around libavcodec's send/receive API,
// built by build-ffmpeg-decoders.sh. JavaScript writes a packet into the buffer the handle hands out,
// sends it, then receives frames until none are left, reading each through the getters below.

#include <emscripten.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>

#include "libavcodec/avcodec.h"
#include "libavutil/channel_layout.h"
#include "libavutil/log.h"
#include "libavutil/mem.h"

typedef struct {
	AVCodecContext *codec;
	AVPacket *packet;
	AVFrame *frame;
} Decoder;

enum {
	CODEC_AC3 = 0,
	CODEC_EAC3 = 1,
	CODEC_DTS = 2,
	CODEC_TRUEHD = 3,
	CODEC_ALAC = 4,
	CODEC_FLAC = 5,
	CODEC_WMAV1 = 6,
	CODEC_WMAV2 = 7,
	CODEC_WMAPRO = 8,
	CODEC_WMALOSSLESS = 9,
	CODEC_MP1 = 10,
	CODEC_MP2 = 11,
	CODEC_AMRNB = 12,
	CODEC_AMRWB = 13,
	CODEC_ADPCM_MS = 14,
	CODEC_ADPCM_IMA_WAV = 15,
	CODEC_ADPCM_SWF = 16,
	CODEC_PCM_DVD = 17
};

static enum AVCodecID codec_id_of(int codec) {
	switch (codec) {
	case CODEC_AC3:
		return AV_CODEC_ID_AC3;
	case CODEC_EAC3:
		return AV_CODEC_ID_EAC3;
	case CODEC_DTS:
		return AV_CODEC_ID_DTS;
	case CODEC_TRUEHD:
		return AV_CODEC_ID_TRUEHD;
	case CODEC_ALAC:
		return AV_CODEC_ID_ALAC;
	case CODEC_FLAC:
		return AV_CODEC_ID_FLAC;
	case CODEC_WMAV1:
		return AV_CODEC_ID_WMAV1;
	case CODEC_WMAV2:
		return AV_CODEC_ID_WMAV2;
	case CODEC_WMAPRO:
		return AV_CODEC_ID_WMAPRO;
	case CODEC_WMALOSSLESS:
		return AV_CODEC_ID_WMALOSSLESS;
	case CODEC_MP1:
		return AV_CODEC_ID_MP1;
	case CODEC_MP2:
		return AV_CODEC_ID_MP2;
	case CODEC_AMRNB:
		return AV_CODEC_ID_AMR_NB;
	case CODEC_AMRWB:
		return AV_CODEC_ID_AMR_WB;
	case CODEC_ADPCM_MS:
		return AV_CODEC_ID_ADPCM_MS;
	case CODEC_ADPCM_IMA_WAV:
		return AV_CODEC_ID_ADPCM_IMA_WAV;
	case CODEC_ADPCM_SWF:
		return AV_CODEC_ID_ADPCM_SWF;
	case CODEC_PCM_DVD:
		return AV_CODEC_ID_PCM_DVD;
	default:
		return AV_CODEC_ID_NONE;
	}
}

// What decoder_send and decoder_receive return besides 0 (a frame is ready, or the packet was taken)
// and AVERROR(ENOMEM), the one failure that ends the stream.
enum { RESULT_DONE = 1, RESULT_SKIPPED = 2 };

// Like the ffmpeg tool, any decoding error only loses the packet it came from: the AC-3 decoder reports a
// damaged header with its own codes, E-AC-3 an unsupported feature with AVERROR_PATCHWELCOME, and the
// frames around it still decode. Running out of memory is not something the next packet recovers from.
static int recoverable(int ret) {
	return ret < 0 && ret != AVERROR(ENOMEM);
}

// FFmpeg's log goes to the console, a line per damaged frame: quiet unless a debugging session raises it
// (an AV_LOG_* level).
static int log_level = AV_LOG_QUIET;

EMSCRIPTEN_KEEPALIVE
void decoder_log_level(int level) {
	log_level = level;
	av_log_set_level(level);
}

static void decoder_free(Decoder *decoder) {
	av_frame_free(&decoder->frame);
	av_packet_free(&decoder->packet);
	avcodec_free_context(&decoder->codec);
	free(decoder);
}

// A zeroed buffer of `size` bytes (plus FFmpeg's padding) the codec configuration is written into before
// decoder_open takes it over, or NULL when out of memory.
EMSCRIPTEN_KEEPALIVE
uint8_t *decoder_extradata(int size) {
	return size <= 0 ? NULL : av_mallocz((size_t)size + AV_INPUT_BUFFER_PADDING_SIZE);
}

// `extradata` (from decoder_extradata, or NULL) is the decoder's from here on, freed with it or here on failure. The
// stream's WAVEFORMATEX fields (0 where the container has none): WMA and ADPCM need the block size, WMA the bit rate,
// ADPCM the bits per sample, and the decoders that read no header of their own the rate and channels.
EMSCRIPTEN_KEEPALIVE
Decoder *decoder_open(int codec_id, uint8_t *extradata, int extradata_size, int block_align, int bit_rate, int sample_rate,
	int channels, int bits_per_sample) {
	const AVCodec *codec = avcodec_find_decoder(codec_id_of(codec_id));
	Decoder *decoder = calloc(1, sizeof(Decoder));

	av_log_set_level(log_level);

	if (codec == NULL || decoder == NULL) {
		free(decoder);
		av_free(extradata);
		return NULL;
	}

	decoder->codec = avcodec_alloc_context3(codec);
	decoder->packet = av_packet_alloc();
	decoder->frame = av_frame_alloc();

	if (decoder->codec == NULL || decoder->packet == NULL || decoder->frame == NULL) {
		av_free(extradata);
		decoder_free(decoder);
		return NULL;
	}

	if (extradata != NULL) {
		decoder->codec->extradata = extradata;
		decoder->codec->extradata_size = extradata_size;
	}

	// Timestamps travel in microseconds and come back unchanged on the frames they belong to.
	decoder->codec->pkt_timebase = (AVRational){1, 1000000};
	decoder->codec->block_align = block_align > 0 ? block_align : 0;
	decoder->codec->bit_rate = bit_rate > 0 ? bit_rate : 0;
	decoder->codec->sample_rate = sample_rate > 0 ? sample_rate : 0;
	decoder->codec->bits_per_coded_sample = bits_per_sample > 0 ? bits_per_sample : 0;

	if (channels > 0) {
		av_channel_layout_default(&decoder->codec->ch_layout, channels);
	}

	if (avcodec_open2(decoder->codec, codec, NULL) < 0) {
		decoder_free(decoder);
		return NULL;
	}

	return decoder;
}

// A buffer of `size` bytes the next packet is written into, or NULL when out of memory.
EMSCRIPTEN_KEEPALIVE
uint8_t *decoder_packet(Decoder *decoder, int size) {
	av_packet_unref(decoder->packet);

	return av_new_packet(decoder->packet, size) < 0 ? NULL : decoder->packet->data;
}

EMSCRIPTEN_KEEPALIVE
int decoder_send(Decoder *decoder, double timestamp_us) {
	decoder->packet->pts = (int64_t)llround(timestamp_us);

	int ret = avcodec_send_packet(decoder->codec, decoder->packet);

	av_packet_unref(decoder->packet);

	return recoverable(ret) ? RESULT_SKIPPED : ret;
}

// Starts draining: every frame still held is then received before RESULT_DONE.
EMSCRIPTEN_KEEPALIVE
int decoder_drain(Decoder *decoder) {
	int ret = avcodec_send_packet(decoder->codec, NULL);

	return recoverable(ret) ? 0 : ret;
}

EMSCRIPTEN_KEEPALIVE
int decoder_receive(Decoder *decoder) {
	int ret = avcodec_receive_frame(decoder->codec, decoder->frame);

	return ret == AVERROR(EAGAIN) || ret == AVERROR_EOF || recoverable(ret) ? RESULT_DONE : ret;
}

// Back to accepting packets after a drain.
EMSCRIPTEN_KEEPALIVE
void decoder_reset(Decoder *decoder) {
	avcodec_flush_buffers(decoder->codec);
}

EMSCRIPTEN_KEEPALIVE
int decoder_format(Decoder *decoder) {
	return decoder->frame->format;
}

EMSCRIPTEN_KEEPALIVE
int decoder_channels(Decoder *decoder) {
	return decoder->frame->ch_layout.nb_channels;
}

// The speakers of the planes as an AV_CH_* bit mask, or -1 when the layout is not in FFmpeg's native order
// and so not described by one. A double, exact for every position these decoders produce (bits below 53).
EMSCRIPTEN_KEEPALIVE
double decoder_channel_mask(Decoder *decoder) {
	const AVChannelLayout *layout = &decoder->frame->ch_layout;

	return layout->order == AV_CHANNEL_ORDER_NATIVE ? (double)layout->u.mask : -1;
}

EMSCRIPTEN_KEEPALIVE
int decoder_sample_rate(Decoder *decoder) {
	return decoder->frame->sample_rate;
}

EMSCRIPTEN_KEEPALIVE
int decoder_frames(Decoder *decoder) {
	return decoder->frame->nb_samples;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *decoder_plane(Decoder *decoder, int plane) {
	return decoder->frame->extended_data[plane];
}

EMSCRIPTEN_KEEPALIVE
double decoder_timestamp(Decoder *decoder) {
	return decoder->frame->pts == AV_NOPTS_VALUE ? NAN : (double)decoder->frame->pts;
}

EMSCRIPTEN_KEEPALIVE
void decoder_close(Decoder *decoder) {
	decoder_free(decoder);
}
