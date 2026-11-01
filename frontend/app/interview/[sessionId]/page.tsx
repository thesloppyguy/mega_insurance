"use client"

import { Suspense, useEffect, useState } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"

import { InterviewRoom } from "@/components/interview-room"
import { fetchToken } from "@/lib/api"

function InterviewInner() {
  const params = useParams<{ sessionId: string }>()
  const search = useSearchParams()
  const router = useRouter()
  const [token, setToken] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const sessionId = params.sessionId
    const name = search.get("name") || "Candidate"
    void (async () => {
      try {
        const res = await fetchToken(sessionId, name)
        setToken(res.participantToken)
        setServerUrl(res.serverUrl)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to join")
      }
    })()
  }, [params.sessionId, search])

  if (error) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-zinc-950 text-rose-300">
        {error}
      </div>
    )
  }

  if (!token || !serverUrl) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-zinc-950 text-zinc-400">
        Preparing room…
      </div>
    )
  }

  return (
    <InterviewRoom
      token={token}
      serverUrl={serverUrl}
      sessionId={params.sessionId}
      onLeave={() => router.push(`/report/${params.sessionId}`)}
    />
  )
}

export default function InterviewPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-svh items-center justify-center bg-zinc-950 text-zinc-400">
          Preparing room…
        </div>
      }
    >
      <InterviewInner />
    </Suspense>
  )
}
