"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

import { createSession } from "@/lib/api"

export default function Page() {
  const router = useRouter()
  const [name, setName] = useState("Candidate")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const session = await createSession(name.trim() || "Candidate")
      router.push(`/interview/${session.session_id}?name=${encodeURIComponent(name)}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_20%_20%,_#1f3a46_0%,_transparent_40%),radial-gradient(circle_at_80%_0%,_#3a2f1f_0%,_transparent_35%),linear-gradient(160deg,#0b0f14,#121820)] px-6 text-zinc-100">
      <div className="absolute inset-0 bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2240%22><path d=%22M0 40L40 0%22 stroke=%22%23ffffff08%22/></svg>')] opacity-60" />
      <div className="relative z-10 w-full max-w-lg">
        <p className="mb-3 text-xs tracking-[0.35em] text-teal-300/80 uppercase">Mavrik</p>
        <h1 className="font-serif text-5xl leading-tight text-zinc-50">
          Identity & body scan interview
        </h1>
        <p className="mt-4 max-w-md text-sm leading-relaxed text-zinc-400">
          Start a LiveKit session with Anam avatar guidance, Muse-powered KYC and body
          analysis, live proctoring, and a disclosed AI estimate report.
        </p>
        <label className="mt-8 block text-xs text-zinc-500">Participant name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm outline-none ring-teal-400/40 focus:ring"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void start()}
          className="mt-4 w-full rounded-xl bg-teal-400 px-4 py-3 text-sm font-semibold text-black disabled:opacity-50"
        >
          {busy ? "Creating session…" : "Start interview"}
        </button>
        {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
        <p className="mt-6 text-[11px] leading-relaxed text-amber-200/70">
          Estimated height, weight, BMI, heart rate, and respiratory rate in reports are AI
          estimates only — not clinical measurements or medical advice.
        </p>
      </div>
    </div>
  )
}
