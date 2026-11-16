// The tiny pictures the boot probe decodes to learn which formats this browser shows by itself (nativeImageSupport.ts).
// Base64, so the e2e suite uploads the same bytes as a Buffer.

// A 64×64 HEVC still, 754 bytes. Not smaller: HEVC pads a tiny picture up to its minimum coded size, and libheif
// refuses a frame larger than the size the container declares (an 8×8 still codes as 160×64). Made with
// `sips -s format heic in.png --out out.heic`.
export const HEIC_PROBE_BASE64 =
	"AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABhW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAOVpcHJwAAAAxGlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAAQAAAAEAAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAAcGh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4AAALA6AAAQAXQAEMAf//A3AAAAMAsAAAAwAAAwAecCShAAEAIkIBAQNwAAADALAAAAMAAAMAHqAUIEHBj4h7kWVTcCAgYAiiAAEACUQBwGFyyERTZAAAABlpcG1hAAAAAAAAAAEAAQaBAgMFhoQAAAAeaWxvYwAAAABEAAABAAEAAAABAAABuQAAATkAAAABbWRhdAAAAAAAAAFJAAABNSgBr6ERkEZ9HA86/vpv71GtvoM4HwXdXfRABkZ3iD/fuZPiCjiwnuhQMOvRTiY5x0a8lknl3ivjRHRAgz651/a2gjDYH2F5godiPDUAHIXDPIvyLW1+NPIw4Jm0HV3S7apwNGdRPINvtf9Gvqvh741XtvAfhpQ1r+TH1WichLthDxwA8vxfy2AJ/Jn2/6SqgoF/oEUvCeBV1cjAEBIRq+YGF2M5O5+tMZKbcVVT0xX2k7vV3TdoKXWebv8M7di4GqnythvHVx9jRsNJXYCxGxivmhjJpC7xgGfr+32QylQGvLenMmQSble5LbPjIroBFjLKVW0Wr1RXYwTOkYOWGMKB8Leuo+CRugS1rIsZYpJx4mFQxVLSLDENcPy/cdY1j1TGcvVameGxN5Mg22DDYHf+ZnXD/w=="

// A 1×1 red pixel as a bare lossless JPEG XL codestream, 25 bytes (libjxl, effort 9).
export const JXL_PROBE_BASE64 = "/woAELASCAgQADQASxiLFSZA9C8A/g8gMg=="
