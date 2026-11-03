import type { NextConfig } from "next"
import { existsSync, readFileSync } from "fs"
import path from "path"

/** Load repo-root `.env` so LiveKit / worker secrets are shared with the worker. */
function loadRootEnv() {
  const envPath = path.join(__dirname, "..", ".env")
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

const nextConfig: NextConfig = {
  // MediaPipe is loaded from CDN at runtime (see lib/pose.ts) because its
  // vision_bundle.mjs uses dynamic import() that Turbopack cannot resolve.
  async redirects() {
    return [
      {
        source: "/home",
        destination: "/",
        permanent: false,
      },
    ]
  },
}

export default nextConfig
