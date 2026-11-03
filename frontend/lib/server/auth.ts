import { NextResponse } from "next/server"

import { WORKER_API_KEY } from "./config"

export function requireWorker(req: Request): NextResponse | null {
  const key = req.headers.get("x-worker-api-key")
  if (key !== WORKER_API_KEY) {
    return NextResponse.json({ detail: "invalid worker api key" }, { status: 401 })
  }
  return null
}
