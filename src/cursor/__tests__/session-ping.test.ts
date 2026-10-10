import { afterEach, describe, expect, it } from "bun:test"
import http2 from "node:http2"
import net from "node:net"
import {
  cacheHttp2SessionForTests,
  closeCachedHttp2SessionsForTests,
  getSession,
} from "../transport/connect.ts"

const ORIGIN = "https://agentn.ping-test.cursor.sh"

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("expected TCP address")
  return address.port
}

describe("getSession cached-session ping failure", () => {
  const connect = http2.connect.bind(http2)

  afterEach(() => {
    http2.connect = connect
    closeCachedHttp2SessionsForTests()
  })

  it.each(["refused", "timeout", "callback-error", "throw"])(
    "retires after a %s ping without aborting sibling Runs",
    async (failure) => {
      let release: () => void = () => {}
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const server = http2.createServer()
      server.on("stream", (stream) => {
        stream.respond({ ":status": 200 })
        stream.write("first")
        void released.then(() => stream.end("last"))
      })
      const serverPort = await listen(server)
      const client = http2.connect(`http://127.0.0.1:${serverPort}`)
      try {
        await new Promise<void>((resolve, reject) => {
          client.once("connect", () => resolve())
          client.once("error", reject)
        })
        cacheHttp2SessionForTests(ORIGIN, client)

        const sibling = client.request({ ":path": "/run" })
        let body = ""
        const firstChunk = new Promise<void>((resolve) => sibling.once("data", () => resolve()))
        sibling.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8")
        })
        const ended = new Promise<void>((resolve, reject) => {
          sibling.once("end", () => resolve())
          sibling.once("error", reject)
        })
        await firstChunk

        client.ping = ((payloadOrCallback, callback) => {
          const done = typeof payloadOrCallback === "function" ? payloadOrCallback : callback
          if (failure === "throw") throw new Error("ping failed")
          if (failure === "callback-error" && typeof done === "function") {
            done(new Error("ping failed"), 0, Buffer.alloc(8))
          }
          return failure !== "refused"
        }) as typeof client.ping
        // The replacement dial must fail here. A real connect would leave the test.
        http2.connect = (() => connect("http://127.0.0.1:1")) as typeof http2.connect

        const error = await getSession(ORIGIN, { pingTimeoutMs: 20 }).catch((err: unknown) => err)
        expect(error).toBeInstanceOf(Error)
        expect(client.destroyed).toBe(false)
        expect(client.closed).toBe(true)

        release()
        await ended
        expect(body).toBe("firstlast")
      } finally {
        release()
        closeCachedHttp2SessionsForTests()
        client.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
  )
})
