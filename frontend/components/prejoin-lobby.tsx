"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { OptiModelViewport } from "@/components/optimodel-avatar/OptiModelViewport"
import { useGsplatAvatarWarmup } from "@/hooks/useGsplatAvatarWarmup"
import {
  createFaceLandmarker,
  evaluateFaceVisible,
  type FaceLandmarkerHandle,
} from "@/lib/face-detect"

const STABLE_FRAMES_REQUIRED = 8
const AVATAR_ID = "sanjay"

type Props = {
  onStart: (callerName: string) => Promise<void> | void
}

export function PrejoinLobby({ onStart }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const landmarkerRef = useRef<FaceLandmarkerHandle | null>(null)
  const rafRef = useRef<number | null>(null)
  const stableCountRef = useRef(0)
  const mediaGenRef = useRef(0)
  const micOnRef = useRef(true)
  const camOnRef = useRef(true)
  const restartCountRef = useRef(0)
  const startingRef = useRef(false)
  const MAX_MEDIA_RESTARTS = 2

  const [callerName, setCallerName] = useState("")
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [micLevel, setMicLevel] = useState(0)
  const [faceVisible, setFaceVisible] = useState(false)
  const [faceHint, setFaceHint] = useState("Starting camera…")
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [avatarStatus, setAvatarStatus] = useState("warming…")
  /** Bumped to force a clean getUserMedia restart after Soft-nav / dead preview. */
  const [mediaEpoch, setMediaEpoch] = useState(0)

  micOnRef.current = micOn
  camOnRef.current = camOn

  const requestMediaRestart = useCallback(() => {
    if (startingRef.current) return
    if (restartCountRef.current >= MAX_MEDIA_RESTARTS) return
    restartCountRef.current += 1
    setMediaEpoch((n) => n + 1)
  }, [])

  const { status: warmStatus, message: warmMessage } = useGsplatAvatarWarmup({
    enabled: true,
    avatarId: AVATAR_ID,
  })

  const attachStreamToVideo = useCallback(async (stream: MediaStream) => {
    const video = videoRef.current
    if (!video) return
    if (video.srcObject !== stream) {
      video.srcObject = stream
    }
    video.muted = true
    video.setAttribute("playsinline", "true")
    try {
      await video.play()
    } catch {
      /* autoplay can fail briefly after Soft-nav; revive path retries */
    }
  }, [])

  const setVideoEl = useCallback(
    (el: HTMLVideoElement | null) => {
      videoRef.current = el
      const stream = streamRef.current
      if (el && stream) {
        void attachStreamToVideo(stream)
      }
    },
    [attachStreamToVideo]
  )

  const stopMedia = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks().forEach((t) => {
      try {
        t.stop()
      } catch {
        /* ignore */
      }
    })
    const video = videoRef.current
    if (video) {
      video.srcObject = null
    }
    // Do NOT close the shared FaceLandmarker — it is a process-wide singleton
    // and closing it crashes the interview page on the next detectForVideo.
    landmarkerRef.current = null
  }, [])

  useEffect(() => {
    let cancelled = false
    let audioCtx: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let levelRaf = 0
    let reviveTimer: ReturnType<typeof setTimeout> | undefined
    let reviveTimer2: ReturnType<typeof setTimeout> | undefined
    const gen = ++mediaGenRef.current

    async function start() {
      startingRef.current = true
      setMediaError(null)
      setFaceHint("Starting camera…")
      setFaceVisible(false)
      stableCountRef.current = 0
      try {
        // Let prior LiveKit Soft-nav sessions finish releasing the device.
        await new Promise((r) => setTimeout(r, 200))
        if (cancelled || gen !== mediaGenRef.current) return

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        })
        if (cancelled || gen !== mediaGenRef.current) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        for (const track of stream.getAudioTracks()) {
          track.enabled = micOnRef.current
        }
        for (const track of stream.getVideoTracks()) {
          track.enabled = camOnRef.current
        }
        await attachStreamToVideo(stream)
        startingRef.current = false

        // Black preview after Soft-nav: re-bind, then one capped restart.
        reviveTimer = setTimeout(() => {
          if (cancelled || gen !== mediaGenRef.current) return
          const el = videoRef.current
          const live = streamRef.current
            ?.getVideoTracks()
            .some((t) => t.readyState === "live")
          if (el && live && el.videoWidth === 0 && streamRef.current) {
            void attachStreamToVideo(streamRef.current)
            reviveTimer2 = setTimeout(() => {
              if (cancelled || gen !== mediaGenRef.current) return
              if (videoRef.current && videoRef.current.videoWidth === 0) {
                requestMediaRestart()
              }
            }, 800)
          }
        }, 900)

        audioCtx = new AudioContext()
        const source = audioCtx.createMediaStreamSource(stream)
        analyser = audioCtx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        const data = new Uint8Array(analyser.frequencyBinCount)
        const tickLevel = () => {
          if (!analyser) return
          analyser.getByteFrequencyData(data)
          let sum = 0
          for (const v of data) sum += v
          setMicLevel(Math.min(1, sum / (data.length * 128)))
          levelRaf = requestAnimationFrame(tickLevel)
        }
        tickLevel()

        try {
          const lm = await createFaceLandmarker()
          if (cancelled || gen !== mediaGenRef.current) {
            lm.close()
            return
          }
          landmarkerRef.current = lm
          const loop = () => {
            const el = videoRef.current
            const marker = landmarkerRef.current
            if (!el || !marker || el.readyState < 2 || el.videoWidth === 0) {
              rafRef.current = requestAnimationFrame(loop)
              return
            }
            try {
              const result = marker.detectForVideo(el, performance.now())
              const assessment = evaluateFaceVisible(result)
              if (assessment.faceVisible) {
                stableCountRef.current += 1
              } else {
                stableCountRef.current = 0
              }
              const stable = stableCountRef.current >= STABLE_FRAMES_REQUIRED
              setFaceVisible(stable)
              setFaceHint(
                stable ? "Face detected — ready to start" : assessment.hint
              )
            } catch {
              /* frame skip */
            }
            rafRef.current = requestAnimationFrame(loop)
          }
          rafRef.current = requestAnimationFrame(loop)
        } catch (err) {
          setFaceHint(
            err instanceof Error
              ? `Face detection unavailable: ${err.message}`
              : "Face detection unavailable"
          )
        }
      } catch (err) {
        startingRef.current = false
        if (cancelled || gen !== mediaGenRef.current) return
        const message =
          err instanceof Error
            ? err.message
            : "Could not access camera or microphone"
        setMediaError(message)
        setFaceHint("Enable camera and microphone to continue")
        toast.error(message)
      } finally {
        startingRef.current = false
      }
    }

    void start()
    return () => {
      cancelled = true
      startingRef.current = false
      clearTimeout(reviveTimer)
      clearTimeout(reviveTimer2)
      cancelAnimationFrame(levelRaf)
      void audioCtx?.close()
      stopMedia()
    }
  }, [attachStreamToVideo, mediaEpoch, requestMediaRestart, stopMedia])

  // Soft-nav back from report can leave a dead stream; restart when visible again.
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | undefined
    const restartIfDead = () => {
      if (document.visibilityState !== "visible") return
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        if (startingRef.current) return
        const el = videoRef.current
        const stream = streamRef.current
        const live = stream
          ?.getVideoTracks()
          .some((t) => t.readyState === "live")
        if (!stream || !live) {
          requestMediaRestart()
          return
        }
        if (el && el.videoWidth === 0) {
          void attachStreamToVideo(stream)
          return
        }
        if (el && stream) {
          void attachStreamToVideo(stream)
        }
      }, 400)
    }
    window.addEventListener("focus", restartIfDead)
    document.addEventListener("visibilitychange", restartIfDead)
    return () => {
      clearTimeout(debounce)
      window.removeEventListener("focus", restartIfDead)
      document.removeEventListener("visibilitychange", restartIfDead)
    }
  }, [attachStreamToVideo, requestMediaRestart])

  useEffect(() => {
    const stream = streamRef.current
    if (!stream) return
    for (const track of stream.getAudioTracks()) {
      track.enabled = micOn
    }
  }, [micOn])

  useEffect(() => {
    const stream = streamRef.current
    if (!stream) return
    for (const track of stream.getVideoTracks()) {
      track.enabled = camOn
    }
    if (!camOn) {
      setFaceVisible(false)
      stableCountRef.current = 0
      setFaceHint("Turn on your camera")
    } else if (streamRef.current) {
      void attachStreamToVideo(streamRef.current)
    }
  }, [attachStreamToVideo, camOn])

  const canStart =
    Boolean(callerName.trim()) &&
    micOn &&
    camOn &&
    faceVisible &&
    !busy &&
    !mediaError

  async function handleStart() {
    if (!canStart) return
    setBusy(true)
    setError(null)
    try {
      stopMedia()
      toast.message("Starting interview…")
      await onStart(callerName.trim())
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start"
      setError(message)
      toast.error(message)
      setBusy(false)
      restartCountRef.current = 0
      requestMediaRestart()
    }
  }

  const warmLabel =
    warmStatus === "ready"
      ? warmMessage || "Sanjay ready"
      : warmStatus === "error"
        ? warmMessage || "Warm failed"
        : warmMessage || avatarStatus

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_15%_20%,_#d8f3ef_0%,_transparent_42%),radial-gradient(circle_at_85%_0%,_#fde8c8_0%,_transparent_38%),linear-gradient(160deg,#f8fafc,#eef2f7)] px-6 py-10 text-zinc-900">
      <div className="relative z-10 w-full max-w-5xl">
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="relative aspect-video overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-900 shadow-sm">
            <video
              ref={setVideoEl}
              muted
              playsInline
              autoPlay
              className={`h-full w-full scale-x-[-1] object-cover ${camOn ? "" : "opacity-0"}`}
            />
            {!camOn ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400">
                Camera off
              </div>
            ) : null}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-4 py-3">
              <p
                className={`text-sm font-medium ${faceVisible ? "text-teal-200" : "text-amber-200"}`}
              >
                {faceHint}
              </p>
            </div>
          </div>

          <div className="relative aspect-[3/4] max-h-[420px] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm lg:aspect-auto lg:min-h-[280px]">
            <OptiModelViewport
              avatarId={AVATAR_ID}
              onStatus={setAvatarStatus}
              className="absolute inset-0"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-white via-white/90 to-transparent px-4 py-3">
              <p
                className={`text-sm font-medium ${
                  warmStatus === "ready"
                    ? "text-teal-700"
                    : warmStatus === "error"
                      ? "text-rose-600"
                      : "text-zinc-600"
                }`}
              >
                Sanjay · {warmLabel}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <label className="block text-xs font-semibold text-zinc-500">
            Your name (caller_name)
            <input
              value={callerName}
              onChange={(e) => setCallerName(e.target.value)}
              placeholder="Enter your full name"
              className="mt-2 w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 ring-teal-500/30 outline-none placeholder:text-zinc-400 focus:ring"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setMicOn((v) => {
                  toast.message(v ? "Microphone muted" : "Microphone on")
                  return !v
                })
              }}
              className={`rounded-xl border px-4 py-3 text-sm font-semibold ${
                micOn
                  ? "border-teal-200 bg-teal-50 text-teal-800"
                  : "border-zinc-200 bg-white text-zinc-500"
              }`}
            >
              Mic {micOn ? "on" : "off"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCamOn((v) => {
                  toast.message(v ? "Camera off" : "Camera on")
                  return !v
                })
              }}
              className={`rounded-xl border px-4 py-3 text-sm font-semibold ${
                camOn
                  ? "border-teal-200 bg-teal-50 text-teal-800"
                  : "border-zinc-200 bg-white text-zinc-500"
              }`}
            >
              Camera {camOn ? "on" : "off"}
            </button>
          </div>

          <button
            type="button"
            disabled={!canStart}
            onClick={() => void handleStart()}
            className="rounded-xl bg-teal-500 px-6 py-3 text-sm font-semibold text-white hover:bg-teal-600 disabled:opacity-40"
          >
            {busy ? "Starting…" : "Start interview"}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-4">
          <div className="min-w-[140px] flex-1">
            <p className="mb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
              Mic level
            </p>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-200">
              <div
                className="h-full rounded-full bg-teal-500 transition-[width] duration-75"
                style={{ width: `${Math.round(micLevel * 100)}%` }}
              />
            </div>
          </div>
          {!canStart && !busy ? (
            <p className="text-xs text-zinc-500">
              Enable mic and camera, enter your name, and keep your face visible
              to unlock Start.
            </p>
          ) : null}
        </div>

        {mediaError ? (
          <p className="mt-3 text-sm text-rose-600">{mediaError}</p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
      </div>
    </div>
  )
}
