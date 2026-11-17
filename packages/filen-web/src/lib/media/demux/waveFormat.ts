import type { AudioCodec } from "mediabunny"

const WAVE_FORMAT_PCM = 0x0001
const WAVE_FORMAT_IEEE_FLOAT = 0x0003

// The PCM sample format a WAVEFORMATEX's tag (an extensible one's sub-format, waveFormatTag) and bits per sample name;
// null for another tag or a sample size nothing decodes.
export function pcmCodec(tag: number, bits: number): AudioCodec | null {
	if (tag === WAVE_FORMAT_IEEE_FLOAT) {
		return bits === 32 ? "pcm-f32" : bits === 64 ? "pcm-f64" : null
	}

	if (tag !== WAVE_FORMAT_PCM) {
		return null
	}

	return bits === 8 ? "pcm-u8" : bits === 16 ? "pcm-s16" : bits === 24 ? "pcm-s24" : bits === 32 ? "pcm-s32" : null
}
