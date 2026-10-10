import path from "node:path"

/** Combined attachment budget, matching a typical desktop chat limit. */
export const MAX_CURSOR_IMAGE_INPUT_BYTES = 20 * 1024 * 1024

const FETCH_TIMEOUT_MS = 30_000

export type CursorImageInput = {
  data: Uint8Array
  filename: string
  mimeType: string
}

export class CursorImageInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CursorImageInputError"
  }
}

type PromptMessage = { role?: string; content?: unknown }

export function promptHasImages(prompt: readonly PromptMessage[], includeHistory: boolean): boolean {
  return userFileParts(prompt, includeHistory).some((part) => isImageMediaType(part.mediaType))
}

/**
 * Decode image file parts on user messages into bytes for UserMessage.selected_context.
 * `includeHistory` is for a fresh Run with no checkpoint. A later turn echoes the
 * checkpoint, so only the latest user message's images are new.
 */
export async function extractPromptImages(
  prompt: readonly PromptMessage[],
  options: { includeHistory: boolean; signal?: AbortSignal; maxBytes?: number },
): Promise<CursorImageInput[]> {
  const maxBytes = budget(options.maxBytes)
  const images: CursorImageInput[] = []
  let used = 0
  for (const part of userFileParts(prompt, options.includeHistory)) {
    if (!isImageMediaType(part.mediaType)) {
      const kind = typeof part.mediaType === "string" ? part.mediaType : "unknown"
      throw new CursorImageInputError(`Only image attachments are supported, not ${kind}.`)
    }
    const resolved = await resolveImageBytes(part, maxBytes - used, maxBytes, options.signal)
    used += resolved.data.length
    const filename =
      (typeof part.filename === "string" && sanitizeFilename(part.filename)) ||
      resolved.filename ||
      `image-${images.length + 1}.${extensionFor(resolved.mimeType)}`
    images.push({ data: resolved.data, filename, mimeType: resolved.mimeType })
  }
  return images
}

function userFileParts(
  prompt: readonly PromptMessage[],
  includeHistory: boolean,
): Array<Record<string, unknown>> {
  let lastUser = -1
  for (let i = 0; i < prompt.length; i++) {
    if (prompt[i]?.role === "user") lastUser = i
  }
  if (lastUser < 0) return []

  const parts: Array<Record<string, unknown>> = []
  for (let i = 0; i < prompt.length; i++) {
    const message = prompt[i]
    if (message?.role !== "user" || !Array.isArray(message.content)) continue
    if (!includeHistory && i !== lastUser) continue
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue
      const record = part as Record<string, unknown>
      if (record.type === "file") parts.push(record)
    }
  }
  return parts
}

function isImageMediaType(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase().startsWith("image/")
}

function budget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_CURSOR_IMAGE_INPUT_BYTES
  return Math.min(MAX_CURSOR_IMAGE_INPUT_BYTES, Math.max(0, Math.floor(value)))
}

function limitMessage(maxBytes: number): string {
  if (maxBytes >= MAX_CURSOR_IMAGE_INPUT_BYTES) {
    return `Image attachments exceed the ${MAX_CURSOR_IMAGE_INPUT_BYTES / 1024 / 1024} MiB limit.`
  }
  return `Image attachments exceed the ${maxBytes} byte limit.`
}

function assertSize(size: number, remaining: number, maxBytes: number): void {
  if (size > remaining) throw new CursorImageInputError(limitMessage(maxBytes))
}

function decodeBase64(value: string, remaining: number, maxBytes: number): Uint8Array {
  const normalized = value.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/")
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new CursorImageInputError("Image data is not valid base64.")
  }
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0
  assertSize(Math.floor(((normalized.length - padding) * 3) / 4), remaining, maxBytes)
  const bytes = new Uint8Array(Buffer.from(normalized, "base64"))
  if (bytes.length === 0) throw new CursorImageInputError("Image data is empty.")
  assertSize(bytes.length, remaining, maxBytes)
  return bytes
}

function decodeDataUrl(
  value: string,
  remaining: number,
  maxBytes: number,
): { bytes: Uint8Array; mimeType?: string } {
  const comma = value.indexOf(",")
  if (!value.startsWith("data:") || comma < 0) {
    throw new CursorImageInputError("Image data URL is invalid.")
  }
  const meta = value.slice(5, comma)
  const parts = meta.split(";")
  const mime = parts[0]?.toLowerCase()
  if (!mime?.startsWith("image/")) {
    throw new CursorImageInputError("Image data URLs must use an image/* media type.")
  }
  if (!parts.includes("base64")) {
    throw new CursorImageInputError("Image data URLs must be base64-encoded.")
  }
  return { bytes: decodeBase64(value.slice(comma + 1), remaining, maxBytes), mimeType: mime }
}

function sniffImageMime(data: Uint8Array): string | undefined {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png"
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg"
  if (data.length >= 6) {
    const header = Buffer.from(data.subarray(0, 6)).toString("ascii")
    if (header === "GIF87a" || header === "GIF89a") return "image/gif"
  }
  if (
    data.length >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp"
  }
  return undefined
}

function extensionFor(mime: string): string {
  if (mime === "image/jpeg") return "jpg"
  if (mime === "image/png") return "png"
  if (mime === "image/gif") return "gif"
  if (mime === "image/webp") return "webp"
  return "img"
}

function sanitizeFilename(name: string): string | undefined {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "")
  if (!base || base === "." || base === "..") return undefined
  return base.slice(0, 128)
}

async function readBody(response: Response, remaining: number, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > remaining) assertSize(declared, remaining, maxBytes)
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer())
    assertSize(data.length, remaining, maxBytes)
    return data
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.length
      if (total > remaining) {
        await reader.cancel()
        assertSize(total, remaining, maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }
  return data
}

async function fetchImage(
  url: URL,
  remaining: number,
  maxBytes: number,
  callerSignal: AbortSignal | undefined,
): Promise<{ bytes: Uint8Array; filename?: string }> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(url, { signal, redirect: "follow" })
  } catch (error) {
    if (callerSignal?.aborted) throw error
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new CursorImageInputError("Timed out fetching the image URL.")
    }
    throw new CursorImageInputError("Could not fetch the image URL.")
  }
  if (!response.ok) {
    throw new CursorImageInputError(`Could not fetch image URL (HTTP ${response.status}).`)
  }
  return {
    bytes: await readBody(response, remaining, maxBytes),
    filename: filenameFromUrl(url),
  }
}

function filenameFromUrl(url: URL): string | undefined {
  try {
    return sanitizeFilename(decodeURIComponent(path.basename(url.pathname)))
  } catch {
    return sanitizeFilename(path.basename(url.pathname))
  }
}

async function resolveImageBytes(
  part: Record<string, unknown>,
  remaining: number,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<{ data: Uint8Array; mimeType: string; filename?: string }> {
  const raw = part.data
  let bytes: Uint8Array
  let filename: string | undefined

  if (raw instanceof Uint8Array) {
    assertSize(raw.byteLength, remaining, maxBytes)
    bytes = new Uint8Array(raw)
  } else if (typeof raw === "string") {
    if (raw.startsWith("data:")) {
      bytes = decodeDataUrl(raw, remaining, maxBytes).bytes
    } else if (/^https?:\/\//i.test(raw)) {
      const fetched = await fetchImage(new URL(raw), remaining, maxBytes, signal)
      bytes = fetched.bytes
      filename = fetched.filename
    } else {
      bytes = decodeBase64(raw, remaining, maxBytes)
    }
  } else if (raw instanceof URL) {
    if (raw.protocol === "data:") {
      bytes = decodeDataUrl(raw.href, remaining, maxBytes).bytes
    } else if (raw.protocol === "http:" || raw.protocol === "https:") {
      const fetched = await fetchImage(raw, remaining, maxBytes, signal)
      bytes = fetched.bytes
      filename = fetched.filename
    } else {
      throw new CursorImageInputError("Image URLs must be http(s) or base64 data URLs.")
    }
  } else {
    throw new CursorImageInputError("Image data must be bytes, base64, or a URL.")
  }

  const mimeType = sniffImageMime(bytes)
  if (!mimeType) {
    throw new CursorImageInputError("Image data is not a png, jpeg, gif, or webp file.")
  }
  return { data: bytes, mimeType, filename }
}
