"use client"

import { useEffect, useRef } from "react"
import { useLocalParticipant, useTracks } from "@livekit/components-react"
import { Track } from "livekit-client"

type Props = {
  onVideoEl?: (el: HTMLVideoElement | null) => void
  className?: string
}

export function LocalCamera({ onVideoEl, className }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const onVideoElRef = useRef(onVideoEl)
  onVideoElRef.current = onVideoEl

  const { localParticipant } = useLocalParticipant()
  const tracks = useTracks([Track.Source.Camera], { onlySubscribed: false })
  const localCam = tracks.find((t) => t.participant.identity === localParticipant.identity)
  // Stable id — track *object* identity changes often and must not re-attach.
  const trackId =
    localCam?.publication?.trackSid ||
    localCam?.publication?.track?.sid ||
    localCam?.publication?.track?.mediaStreamTrack?.id ||
    null

  useEffect(() => {
    onVideoElRef.current?.(videoRef.current)
    return () => onVideoElRef.current?.(null)
  }, [])

  useEffect(() => {
    const el = videoRef.current
    const track = localCam?.publication?.track
    if (!el || !track || !trackId) return

    track.attach(el)
    void el.play().catch(() => undefined)

    return () => {
      track.detach(el)
    }
    // Intentionally keyed only by trackId so agent/status re-renders don't flicker.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- localCam read when trackId changes
  }, [trackId])

  return (
    <video
      ref={videoRef}
      data-lk-local-camera
      autoPlay
      playsInline
      muted
      className={className ?? "aspect-video w-full object-cover"}
    />
  )
}
