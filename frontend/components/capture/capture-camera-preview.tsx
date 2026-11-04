"use client"

import {
  type TrackReference,
  useLocalParticipant,
  useRoomContext,
  VideoTrack,
} from "@livekit/components-react"
import { Track } from "livekit-client"
import { useMemo } from "react"

type Props = {
  children?: React.ReactNode
  className?: string
}

/** LiveKit local camera preview for capture overlays (may share the published track). */
export function CaptureCameraPreview({ children, className }: Props) {
  const room = useRoomContext()
  const { cameraTrack, isCameraEnabled } = useLocalParticipant()

  const trackRef = useMemo<TrackReference | undefined>(() => {
    if (!cameraTrack) return undefined
    return {
      participant: room.localParticipant,
      publication: cameraTrack,
      source: Track.Source.Camera,
    }
  }, [cameraTrack, room.localParticipant])

  const width = cameraTrack?.dimensions?.width || 1280
  const height = cameraTrack?.dimensions?.height || 720

  return (
    <div
      className={
        className ??
        "relative w-full overflow-hidden rounded-md bg-black"
      }
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      {isCameraEnabled && trackRef?.publication.track ? (
        <>
          <VideoTrack
            trackRef={trackRef}
            className="absolute inset-0 size-full object-cover"
          />
          {children}
        </>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400">
          Turn on your camera to continue.
        </div>
      )}
    </div>
  )
}

export function useCaptureFrameSize() {
  const { cameraTrack } = useLocalParticipant()
  return {
    width: cameraTrack?.dimensions?.width || 1280,
    height: cameraTrack?.dimensions?.height || 720,
  }
}
