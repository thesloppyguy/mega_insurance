"use client"

import { useEffect, useRef } from "react"
import { useLocalParticipant, useTracks } from "@livekit/components-react"
import { Track } from "livekit-client"

type Props = {
  onVideoEl?: (el: HTMLVideoElement | null) => void
}

export function LocalCamera({ onVideoEl }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const { localParticipant } = useLocalParticipant()
  const tracks = useTracks([Track.Source.Camera], { onlySubscribed: false })
  const localCam = tracks.find((t) => t.participant.identity === localParticipant.identity)

  useEffect(() => {
    const el = videoRef.current
    onVideoEl?.(el)
    if (!el) return
    const pub = localCam?.publication
    const track = pub?.track
    if (track) {
      track.attach(el)
      return () => {
        track.detach(el)
      }
    }
  }, [localCam, onVideoEl])

  return (
    <video
      ref={videoRef}
      data-lk-local-camera
      autoPlay
      playsInline
      muted
      className="aspect-video w-full object-cover"
    />
  )
}
