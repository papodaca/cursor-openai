import { describe, expect, it } from "bun:test"
import { CursorImageInputError, extractPromptImages, promptHasImages } from "../image-input.ts"

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const PNG = Buffer.from(PNG_BASE64, "base64")
const DATA_URL = `data:image/png;base64,${PNG_BASE64}`

describe("extractPromptImages", () => {
  it("decodes a data URL on the latest user message", async () => {
    const images = await extractPromptImages(
      [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "file", mediaType: "image/png", data: DATA_URL }] },
      ],
      { includeHistory: false },
    )
    expect(images).toHaveLength(1)
    expect(images[0]?.mimeType).toBe("image/png")
    expect(images[0]?.filename).toBe("image-1.png")
    expect(Buffer.compare(Buffer.from(images[0]!.data), PNG)).toBe(0)
  })

  it("keeps earlier user images only when history is included", async () => {
    const prompt = [
      { role: "user", content: [{ type: "file", mediaType: "image/png", data: DATA_URL, filename: "old.png" }] },
      { role: "assistant", content: [{ type: "text", text: "a pixel" }] },
      { role: "user", content: [{ type: "text", text: "and now?" }] },
    ]
    expect(promptHasImages(prompt, false)).toBe(false)
    expect(promptHasImages(prompt, true)).toBe(true)
    expect(await extractPromptImages(prompt, { includeHistory: false })).toEqual([])
    const images = await extractPromptImages(prompt, { includeHistory: true })
    expect(images.map((image) => image.filename)).toEqual(["old.png"])
  })

  it("fetches an http image and uses the URL filename", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(PNG, { headers: { "content-type": "image/png" } })
      },
    })
    try {
      const images = await extractPromptImages(
        [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "image/*",
                data: new URL(`http://127.0.0.1:${server.port}/photos/shot.png`),
              },
            ],
          },
        ],
        { includeHistory: false },
      )
      expect(images[0]?.filename).toBe("shot.png")
      expect(images[0]?.mimeType).toBe("image/png")
      expect(Buffer.compare(Buffer.from(images[0]!.data), PNG)).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  it("rejects non-image bytes and oversized payloads", async () => {
    const textUrl = `data:image/png;base64,${Buffer.from("hello").toString("base64")}`
    await expect(
      extractPromptImages(
        [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: textUrl }] }],
        { includeHistory: false },
      ),
    ).rejects.toBeInstanceOf(CursorImageInputError)

    await expect(
      extractPromptImages(
        [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: DATA_URL }] }],
        { includeHistory: false, maxBytes: 8 },
      ),
    ).rejects.toThrow(/byte limit/)
  })

  it("rejects file URLs and non-image media types", async () => {
    await expect(
      extractPromptImages(
        [{ role: "user", content: [{ type: "file", mediaType: "application/pdf", data: DATA_URL }] }],
        { includeHistory: false },
      ),
    ).rejects.toThrow(/application\/pdf/)

    await expect(
      extractPromptImages(
        [
          {
            role: "user",
            content: [{ type: "file", mediaType: "image/png", data: new URL("file:///tmp/secret.png") }],
          },
        ],
        { includeHistory: false },
      ),
    ).rejects.toThrow(/http\(s\)/)
  })
})
