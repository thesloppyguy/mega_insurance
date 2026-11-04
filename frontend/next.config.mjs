import { withAvatarkit } from "@spatius/avatarkit/next"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const configDir = dirname(fileURLToPath(import.meta.url))

/** Load repo-root `.env` so LiveKit / worker secrets are shared with the worker. */
function loadRootEnv() {
  const envPath = join(configDir, "..", ".env")
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

loadRootEnv()

/** @type {import("next").NextConfig} */
const nextConfig = {
  // MediaPipe is loaded from CDN at runtime (see lib/face-detect.ts).
  async redirects() {
    return [
      {
        source: "/home",
        destination: "/",
        permanent: false,
      },
    ]
  },
  /**
   * SharedArrayBuffer / WASM threads for OptiModel AvatarKit need
   * cross-origin isolation. CORP on every subresource or Firefox/Chrome
   * blocks WASM under COEP require-corp.
   */
  async headers() {
    const isolation = [
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
    ]
    const corp = [
      { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    ]
    return [
      // Prejoin (`/`) mounts OptiModel for warm; interview continues isolation.
      { source: "/", headers: isolation },
      { source: "/interview/:path*", headers: isolation },
      // Keep the whole session flow isolated (lobby → interview → report →
      // lobby) like optimind-deployement scopes all of /app/*.
      { source: "/report/:path*", headers: isolation },
      { source: "/_next/static/:path*", headers: corp },
      { source: "/_avatarkit/:path*", headers: corp },
      { source: "/assets/:path*", headers: corp },
      { source: "/optimodel/:path*", headers: corp },
      { source: "/avatar-api/:path*", headers: corp },
    ]
  },
}

// withAvatarkit copies WASM to public/_avatarkit and rewrites Emscripten
// scriptDirectory so Next/Turbopack do not resolve *.js/*.wasm (ENOTDIR).
export default withAvatarkit(nextConfig)
