"use client"

import { useEffect, useState } from "react"

import { warmGsplatAvatar, waitForOptiModelWarmupIdle } from "@/lib/gsplat-preload"

/**
 * Best-effort OptiModel warm during the prejoin lobby:
 * prefetch Sanjay pack + AvatarSDK.initialize + AvatarManager.load.
 * Interview OptiModelViewport awaits the same gate via waitForOptiModelWarmupIdle.
 */
export function useGsplatAvatarWarmup(options: {
  enabled: boolean
  avatarId: string | null | undefined
}) {
  const { enabled, avatarId } = options
  const [status, setStatus] = useState<"idle" | "warming" | "ready" | "error">(
    "idle"
  )
  const [message, setMessage] = useState("")

  useEffect(() => {
    if (!enabled || !avatarId) {
      setStatus("idle")
      setMessage("")
      return
    }
    let cancelled = false
    setStatus("warming")
    setMessage("Warming Sanjay…")
    warmGsplatAvatar(avatarId)
    void waitForOptiModelWarmupIdle()
      .then(() => {
        if (cancelled) return
        setStatus("ready")
        setMessage("Sanjay ready")
      })
      .catch((err) => {
        if (cancelled) return
        setStatus("error")
        setMessage(err instanceof Error ? err.message : "Avatar warm failed")
      })
    return () => {
      cancelled = true
    }
  }, [enabled, avatarId])

  return { status, message }
}
