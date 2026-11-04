"use client"

import { Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { PrejoinLobby } from "@/components/prejoin-lobby"
import { createSession } from "@/lib/api"

function HomeInner() {
  const router = useRouter()
  const search = useSearchParams()
  // Cache-bust remount when arriving from "New interview" on the report page.
  const lobbyKey = search.get("new") || "default"

  return (
    <PrejoinLobby
      key={lobbyKey}
      onStart={async (callerName) => {
        const session = await createSession(callerName)
        router.push(
          `/interview/${session.session_id}?name=${encodeURIComponent(callerName)}`
        )
      }}
    />
  )
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-svh items-center justify-center bg-zinc-50 text-zinc-500">
          Starting camera…
        </div>
      }
    >
      <HomeInner />
    </Suspense>
  )
}
