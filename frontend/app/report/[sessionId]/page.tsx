"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"

import { fetchReport, type SessionReport, type UnderwritingReport } from "@/lib/api"

const DISCLOSURE =
  "These values are AI estimates derived from video/images only. They are not clinical measurements, medical advice, or a diagnosis."

export default function ReportPage() {
  const params = useParams<{ sessionId: string }>()
  const [report, setReport] = useState<SessionReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const data = await fetchReport(params.sessionId)
        if (!cancelled) setReport(data)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load")
      }
    }
    void load()
    const id = setInterval(() => void load(), 4000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [params.sessionId])

  const uw = report?.underwriting_report as UnderwritingReport | null | undefined
  const estimates = uw?.body_scan?.estimates || {}

  return (
    <div className="min-h-svh bg-[linear-gradient(180deg,#10151c,#0b0f14)] px-6 py-10 text-zinc-100">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs tracking-[0.3em] text-teal-300/80 uppercase">Mavrik</p>
            <h1 className="mt-2 font-serif text-4xl">Session report</h1>
            <p className="mt-2 text-sm text-zinc-400">Session {params.sessionId}</p>
          </div>
          <Link href="/" className="text-sm text-teal-300 underline-offset-4 hover:underline">
            New interview
          </Link>
        </div>

        <p className="mt-6 rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-100/90">
          {uw?.disclosure || DISCLOSURE}
        </p>

        {error ? <p className="mt-6 text-rose-300">{error}</p> : null}
        {!report ? <p className="mt-6 text-zinc-400">Loading report…</p> : null}

        {report ? (
          <div className="mt-8 space-y-6">
            <Section title="Session status">
              <p className="text-sm">Status: {report.status || "unknown"}</p>
              <p className="text-sm">
                Recommendation: {uw?.underwriting_outcome?.recommendation || "pending"}
              </p>
              <p className="mt-2 text-xs text-zinc-500">{uw?.underwriting_outcome?.notes}</p>
            </Section>

            <Section title="Estimated vitals & body metrics">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Metric label="Height (cm)" value={estimates.height_cm} />
                <Metric label="Weight (kg)" value={estimates.weight_kg} />
                <Metric label="BMI" value={estimates.bmi} />
                <Metric label="Heart rate (bpm)" value={estimates.heart_rate_bpm} />
                <Metric label="Respiratory rate" value={estimates.respiratory_rate_bpm} />
                <Metric label="Fitness" value={estimates.fitness_assessment} />
              </div>
              <p className="mt-3 text-[11px] text-amber-200/70">{DISCLOSURE}</p>
            </Section>

            <Section title="Identity & liveness">
              <StatusLine label="Identity/liveness" status={uw?.identity_liveness?.status} />
              <StatusLine label="Face match" status={uw?.face_matching?.status} />
              <p className="mt-2 text-sm text-zinc-400">
                Match score: {fmt(uw?.face_matching?.match_score)} · matched:{" "}
                {String(uw?.face_matching?.matched ?? "—")}
              </p>
            </Section>

            <Section title="KYC verification">
              <StatusLine label="KYC" status={uw?.kyc?.status} />
              <p className="mt-2 text-sm text-zinc-400">
                Document: {uw?.kyc?.document_type || "—"} · face match:{" "}
                {fmt(uw?.kyc?.face_match_score)}
              </p>
              <pre className="mt-3 overflow-auto rounded-lg bg-black/30 p-3 text-xs text-zinc-400">
                {JSON.stringify(uw?.kyc?.extracted_fields || {}, null, 2)}
              </pre>
            </Section>

            <Section title="Full body analysis">
              <StatusLine label="Body scan" status={uw?.body_scan?.status} />
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-zinc-300">
                {(uw?.body_scan?.physical_conditions || []).map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </Section>

            <Section title="Proctoring">
              <StatusLine label="Proctoring" status={uw?.proctoring?.status} />
              <p className="mt-2 text-sm text-zinc-400">{uw?.proctoring?.summary}</p>
              <p className="mt-2 text-xs text-zinc-500">
                Events logged: {(report.events || []).filter((e) =>
                  String(e.event_type || "").includes("proctor")
                ).length}
              </p>
            </Section>

            <Section title="Audio analysis">
              <StatusLine label="Audio" status={uw?.audio?.status} />
              <p className="mt-2 text-sm text-zinc-400 whitespace-pre-wrap">
                {uw?.audio?.transcript_excerpt || "Transcript pending."}
              </p>
            </Section>

            <Section title="Risk & exceptions">
              <p className="text-sm">
                Risks: {(uw?.underwriting_outcome?.risk_indicators || []).join(", ") || "—"}
              </p>
              <p className="mt-2 text-sm">
                Flags: {(uw?.underwriting_outcome?.exception_flags || []).join(", ") || "—"}
              </p>
            </Section>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <h2 className="font-serif text-2xl text-zinc-50">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function StatusLine({ label, status }: { label: string; status?: string }) {
  return (
    <p className="text-sm">
      {label}: <span className="text-teal-300">{status || "pending"}</span>
    </p>
  )
}

function Metric({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-3">
      <div className="text-[11px] tracking-wide text-zinc-500 uppercase">{label}</div>
      <div className="mt-1 text-lg text-zinc-100">{fmt(value)}</div>
    </div>
  )
}

function fmt(value: unknown) {
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1)
  return String(value)
}
