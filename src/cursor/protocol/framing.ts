import { gunzipSync, gzipSync } from "node:zlib"

export const FLAG_GZIP = 0x01

export type Frame = {
  flags: number
  payload: Uint8Array
}

export function encodeFrame(flags: number, payload: Uint8Array): Uint8Array {
  let data = payload
  if (flags & FLAG_GZIP) {
    data = gzipSync(data)
  }
  const len = data.length
  const header = new Uint8Array(5)
  header[0] = flags
  header[1] = (len >> 24) & 0xff
  header[2] = (len >> 16) & 0xff
  header[3] = (len >> 8) & 0xff
  header[4] = len & 0xff
  const out = new Uint8Array(5 + len)
  out.set(header, 0)
  out.set(data, 5)
  return out
}

export function decodeFramePayload(frame: Frame): Uint8Array {
  return frame.flags & FLAG_GZIP ? gunzipSync(frame.payload) : frame.payload
}

export function* streamFrames(buffer: Uint8Array): Generator<Frame, void, void> {
  let offset = 0
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset]!
    const len =
      ((buffer[offset + 1]! << 24) |
        (buffer[offset + 2]! << 16) |
        (buffer[offset + 3]! << 8) |
        buffer[offset + 4]!) >>> 0
    const start = offset + 5
    if (start + len > buffer.length) break
    yield { flags, payload: buffer.subarray(start, start + len) }
    offset = start + len
  }
}
