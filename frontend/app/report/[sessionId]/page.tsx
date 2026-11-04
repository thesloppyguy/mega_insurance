"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { Inter } from "next/font/google"

import {
  fetchReport,
  type EgressFile,
  type SessionReport,
  type UnderwritingReport,
} from "@/lib/api"

// Reports use a neutral, document-style typeface (the app default is playful).
const reportFont = Inter({ subsets: ["latin"], display: "swap" })

const DISCLOSURE =
  "AI estimates only. Vitals and physical findings are not clinical measurements."

type Tone = "good" | "warn" | "bad" | "neutral"
type Row = [string, React.ReactNode]

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
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load")
      }
    }
    void load()
    const id = setInterval(() => void load(), 4000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [params.sessionId])

  const uw = report?.underwriting_report as
    UnderwritingReport | null | undefined
  const estimates = uw?.body_scan?.estimates || {}
  const sam = uw?.proctoring?.sam_validation
  const outcome = uw?.underwriting_outcome
  const ocr = report?.id_card_ocr
  const fields = ocr?.extracted || {}
  const sessionId = params.sessionId

  const idStatus = uw?.kyc?.status || uw?.identity_liveness?.status
  const identityLabel =
    toneFor(uw?.kyc?.status) === "good"
      ? "Verified"
      : humanize(idStatus) || "Pending"
  const rec = String(outcome?.recommendation || "").toLowerCase()
  const reviewRequired = /(review|refer|decline|reject)/.test(rec)
  const reviewLabel = !rec
    ? "Pending"
    : reviewRequired
      ? "Required"
      : "Not required"
  const confidence =
    typeof ocr?.confidence === "number"
      ? `${Math.round(ocr.confidence * 100)}%`
      : "—"

  const idAsset = latestAssetId(report?.assets, "id")
  const bodyAsset = latestAssetId(report?.assets, "body")
  const faceAsset = latestAssetId(report?.assets, "face")
  const assetUrl = (id: string | null) =>
    id ? `/api/sessions/${sessionId}/assets/${id}` : null

  const responses = buildResponses(report)
  const physical = uw?.body_scan?.physical_conditions || []

  return (
    <div
      className={`${reportFont.className} min-h-svh bg-slate-100 text-slate-900 print:bg-white`}
    >
      <div className="h-1.5 bg-indigo-600" />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-6 py-4">
          <span className="text-lg font-semibold tracking-[0.18em] text-slate-900 uppercase">
            Mega Insurance
          </span>
          <div className="flex items-center gap-4">
            <span className="hidden text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase sm:inline">
              Verification report
            </span>
            <div className="flex items-center gap-2 print:hidden">
              <button
                type="button"
                onClick={() => window.print()}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Save PDF
              </button>
              <button
                type="button"
                // Full page load (not router.push): drops the previous call's
                // WASM/WebGL/MediaPipe state and re-applies COOP/COEP isolation.
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                onClick={() => window.location.assign("/")}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700"
              >
                New interview
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-5 px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              Post Processing Report
            </h1>
            <p className="mt-1 text-sm text-slate-500">Session {sessionId}</p>
          </div>
          {report ? (
            <Badge tone={toneFor(report.status)} upper>
              {humanize(report.status) || "Unknown"}
            </Badge>
          ) : null}
        </div>

        <div className="rounded-md border-l-4 border-amber-600 bg-amber-100 px-4 py-2.5 text-sm font-semibold text-amber-900">
          {uw?.disclosure || DISCLOSURE}
        </div>

        {error ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </p>
        ) : null}
        {!report ? (
          <p className="text-sm text-slate-500">Loading report…</p>
        ) : null}

        {report ? (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Kpi
                label="Identity"
                value={identityLabel}
                tone={toneFor(uw?.kyc?.status)}
              />
              <Kpi label="ID confidence" value={confidence} tone="neutral" />
              <Kpi
                label="Underwriter review"
                value={reviewLabel}
                tone={!rec ? "neutral" : reviewRequired ? "warn" : "good"}
              />
            </div>

            <Card title="Session">
              <Rows
                columns={2}
                rows={[
                  [
                    "Session ID",
                    <span key="s" className="font-mono text-xs">
                      {sessionId}
                    </span>,
                  ],
                  ["Started", formatDate(report.created_at)],
                  ["End user", report.participant_name || "—"],
                  ["Ended", formatDate(report.updated_at)],
                  ["Status", humanize(report.status) || "—"],
                  ["Duration", duration(report.created_at, report.updated_at)],
                ]}
              />
            </Card>

            <Card title="ID card extraction" status={uw?.kyc?.status}>
              <div className="grid gap-6 md:grid-cols-[1fr_260px]">
                <div>
                  <Rows
                    rows={[
                      ["Confidence", confidence],
                      ["Full name", fields.fullName || "—"],
                      ["Document number", fields.documentNumber || "—"],
                      ["Date of birth", fields.dateOfBirth || "—"],
                      ["Expiry date", fields.expiryDate || "—"],
                      ["Nationality", fields.nationality || "—"],
                      [
                        "Document type",
                        ocr?.idType || uw?.kyc?.document_type || "—",
                      ],
                      ["Address", fields.address || "—"],
                      ["Sex", fields.sex || "—"],
                    ]}
                  />
                  {ocr?.summary ? <Callout>{ocr.summary}</Callout> : null}
                </div>
                <Figure caption="ID card" src={assetUrl(idAsset)} />
              </div>
            </Card>

            <Card title="Face & identity checks">
              <div className="grid gap-6 md:grid-cols-[1fr_260px]">
                <Rows
                  rows={[
                    [
                      "Identity",
                      <Badge key="i" tone={toneFor(uw?.kyc?.status)}>
                        {identityLabel}
                      </Badge>,
                    ],
                    [
                      "Liveness",
                      <Badge
                        key="l"
                        tone={
                          sam?.liveness_proxy_ok === false
                            ? "bad"
                            : sam?.liveness_proxy_ok
                              ? "good"
                              : "neutral"
                        }
                      >
                        {sam?.liveness_proxy_ok === undefined
                          ? "Pending"
                          : sam.liveness_proxy_ok
                            ? "Passed"
                            : "Failed"}
                      </Badge>,
                    ],
                    [
                      "Face match",
                      humanize(uw?.face_matching?.status) || "Pending",
                    ],
                    ["Match score", fmt(uw?.face_matching?.match_score)],
                    ["Face coverage", pct(sam?.face_coverage) as string],
                    ["Person coverage", pct(sam?.person_coverage) as string],
                  ]}
                />
                <Figure caption="Face capture" src={assetUrl(faceAsset)} />
              </div>
            </Card>

            <Card title="Body — vitals" badge="Estimate" badgeTone="warn">
              <Rows
                columns={2}
                rows={[
                  ["Height (cm)", fmt(estimates.height_cm)],
                  ["Heart rate", fmt(estimates.heart_rate_bpm)],
                  ["Weight (kg)", fmt(estimates.weight_kg)],
                  ["Resp. rate", fmt(estimates.respiratory_rate_bpm)],
                  ["BMI", fmt(estimates.bmi)],
                ]}
              />
              {estimates.fitness_assessment ? (
                <Callout>
                  Fitness assessment: {String(estimates.fitness_assessment)}
                </Callout>
              ) : null}
            </Card>

            <Card title="Body — physical condition">
              {physical.length ? (
                <Rows
                  rows={physical.map((c, i): Row => [
                    i === 0 ? "Findings" : "",
                    c,
                  ])}
                />
              ) : (
                <p className="text-sm text-slate-500">
                  No observations recorded.
                </p>
              )}
            </Card>

            <Card title="Body — underwriting">
              <div className="grid gap-6 md:grid-cols-[1fr_260px]">
                <div>
                  <Rows
                    rows={[
                      [
                        "Identity",
                        <Badge key="i" tone={toneFor(uw?.kyc?.status)}>
                          {identityLabel}
                        </Badge>,
                      ],
                      [
                        "Body scan",
                        <Badge key="b" tone={toneFor(uw?.body_scan?.status)}>
                          {humanize(uw?.body_scan?.status) || "Pending"}
                        </Badge>,
                      ],
                      ["Risk indicators", listOrDash(outcome?.risk_indicators)],
                      ["Exception flags", listOrDash(outcome?.exception_flags)],
                      [
                        "Review",
                        <Badge
                          key="r"
                          tone={
                            !rec ? "neutral" : reviewRequired ? "warn" : "good"
                          }
                        >
                          {reviewLabel}
                        </Badge>,
                      ],
                    ]}
                  />
                  {outcome?.notes ? <Callout>{outcome.notes}</Callout> : null}
                </div>
                <Figure caption="Body capture" src={assetUrl(bodyAsset)} />
              </div>
            </Card>

            <Card
              title="Media integrity"
              status={
                sam?.status ||
                (uw?.sam_summary?.skipped ? "skipped" : "pending")
              }
              subtitle={`Engine ${uw?.engine?.sam || "sam-3.1"} · source ${String(
                uw?.engine?.sam_source || uw?.sam_summary?.source || "—"
              ).replace(/_/g, " ")}`}
            >
              <Rows
                rows={[
                  [
                    "Multiple persons",
                    <Badge
                      key="m"
                      tone={sam?.multiple_persons ? "warn" : "good"}
                    >
                      {sam?.multiple_persons ? "Yes" : "No"}
                    </Badge>,
                  ],
                  ["ID card frames", fmt(sam?.id_card_frames)],
                  [
                    "Flags",
                    (sam?.flags || []).length ? (
                      <span
                        key="f"
                        className="flex flex-wrap justify-end gap-1.5"
                      >
                        {(sam?.flags || []).map((flag) => (
                          <Badge key={flag} tone="warn">
                            {humanize(flag)}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      "None"
                    ),
                  ],
                  [
                    "Proctoring events",
                    String(
                      (report.events || []).filter((e) =>
                        String(e.event_type || "").includes("proctor")
                      ).length
                    ),
                  ],
                ]}
              />
              {uw?.proctoring?.summary ? (
                <Callout>{uw.proctoring.summary}</Callout>
              ) : null}
              <SamVideoPreview
                sessionId={sessionId}
                overlayAssetId={
                  typeof uw?.sam_summary?.overlay_asset_id === "string"
                    ? uw.sam_summary.overlay_asset_id
                    : findAssetId(report.assets, "sam_overlay")
                }
                clipAssetId={
                  typeof uw?.sam_summary?.clip_asset_id === "string"
                    ? uw.sam_summary.clip_asset_id
                    : findAssetId(report.assets, "sam_clip")
                }
              />
            </Card>

            <Card title="Session recordings">
              <EgressFilesPanel files={report.egress || []} />
            </Card>

            <section className="break-inside-avoid">
              <h2 className="mb-1 flex items-center gap-2 text-base font-semibold">
                <span className="h-5 w-1 rounded bg-indigo-600" />
                User responses
              </h2>
              <p className="mb-3 text-sm text-slate-500">
                {responses.length} answer{responses.length === 1 ? "" : "s"}{" "}
                captured during the session
              </p>
              {responses.length ? (
                <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-900 text-[11px] tracking-wider text-white uppercase">
                      <tr>
                        <th className="w-1/2 px-4 py-2.5 font-semibold">
                          Question
                        </th>
                        <th className="px-4 py-2.5 font-semibold">Answer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {responses.map((r, i) => (
                        <tr
                          key={i}
                          className="border-t border-slate-100 align-top even:bg-slate-50"
                        >
                          <td className="px-4 py-3 font-medium text-slate-900">
                            {r.question}
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            {r.answer}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
                  Transcript pending.
                </p>
              )}
            </section>

            <footer className="pt-2 pb-6 text-center text-xs text-slate-400">
              Mega Insurance · {DISCLOSURE}
            </footer>
          </>
        ) : null}
      </main>
    </div>
  )
}

type Response = { question: string; answer: string }

/** Pair each user turn with the agent line that prompted it. */
function buildResponses(report: SessionReport | null): Response[] {
  const chat = report?.livekit_report?.chat_history as
    { items?: Array<Record<string, unknown>> } | undefined
  const out: Response[] = []
  let lastAgent = ""
  for (const item of chat?.items || []) {
    if (item.type !== "message") continue
    const text = Array.isArray(item.content)
      ? item.content
          .filter((c) => typeof c === "string")
          .join(" ")
          .trim()
      : ""
    if (!text) continue
    if (item.role === "assistant") lastAgent = text
    else if (item.role === "user") {
      out.push({ question: lastAgent || "—", answer: text })
      lastAgent = ""
    }
  }
  return out
}

function latestAssetId(
  assets: Array<Record<string, unknown>> | undefined,
  kind: string
) {
  const rows = (assets || []).filter((a) => String(a.kind || "") === kind)
  const last = rows[rows.length - 1]
  return typeof last?.asset_id === "string" ? last.asset_id : null
}

function formatDate(iso?: string) {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function duration(start?: string, end?: string) {
  if (!start || !end) return "—"
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "—"
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

const TONES: Record<Tone, string> = {
  good: "bg-emerald-100 text-emerald-800",
  warn: "bg-amber-100 text-amber-800",
  bad: "bg-rose-100 text-rose-800",
  neutral: "bg-slate-100 text-slate-600",
}
const KPI_BAR: Record<Tone, string> = {
  good: "bg-emerald-600",
  warn: "bg-amber-500",
  bad: "bg-rose-600",
  neutral: "bg-slate-600",
}
const KPI_TEXT: Record<Tone, string> = {
  good: "text-emerald-700",
  warn: "text-amber-700",
  bad: "text-rose-700",
  neutral: "text-slate-800",
}

function toneFor(value?: string | null): Tone {
  const v = String(value || "").toLowerCase()
  if (!v) return "neutral"
  if (/(fail|reject|decline|error|deny)/.test(v)) return "bad"
  if (
    /(^|_)(ok|pass|passed|verified|approve|approved|complete|completed|clear|active)($|_)/.test(
      v
    )
  )
    return "good"
  if (/(review|refer|pending|flag|started|skipped|warn)/.test(v)) return "warn"
  return "neutral"
}

function humanize(value?: string | null) {
  const s = String(value ?? "")
    .replace(/_/g, " ")
    .trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""
}

function Badge({
  tone,
  upper,
  children,
}: {
  tone: Tone
  upper?: boolean
  children: React.ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        upper ? "tracking-wide uppercase" : ""
      } ${TONES[tone]}`}
    >
      {children}
    </span>
  )
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: Tone
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
      <div className={`h-1 w-7 rounded ${KPI_BAR[tone]}`} />
      <p className="mt-3 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold ${KPI_TEXT[tone]}`}>{value}</p>
    </div>
  )
}

function Card({
  title,
  subtitle,
  status,
  badge,
  badgeTone = "neutral",
  children,
}: {
  title: string
  subtitle?: string
  status?: string | null
  badge?: string
  badgeTone?: Tone
  children: React.ReactNode
}) {
  return (
    <section className="break-inside-avoid rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <span className="h-5 w-1 rounded bg-indigo-600" />
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-1 pl-3 text-xs text-slate-500">{subtitle}</p>
          ) : null}
        </div>
        {badge ? (
          <Badge tone={badgeTone} upper>
            {badge}
          </Badge>
        ) : status ? (
          <Badge tone={toneFor(status)} upper>
            {humanize(status)}
          </Badge>
        ) : null}
      </div>
      <div className="mt-4 border-t border-slate-100 pt-4">{children}</div>
    </section>
  )
}

function Rows({ rows, columns = 1 }: { rows: Row[]; columns?: 1 | 2 }) {
  return (
    <dl className={columns === 2 ? "grid gap-x-10 sm:grid-cols-2" : ""}>
      {rows.map(([label, value], i) => (
        <div
          key={`${label}-${i}`}
          className="grid grid-cols-[130px_1fr] items-baseline gap-3 border-b border-slate-100 py-2 text-sm last:border-b-0"
        >
          <dt className="text-slate-500">{label}</dt>
          <dd className="font-medium text-slate-900">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-md border-l-4 border-indigo-600 bg-indigo-50 px-4 py-3 text-sm leading-relaxed text-slate-800">
      {children}
    </div>
  )
}

function Figure({ caption, src }: { caption: string; src: string | null }) {
  return (
    <figure>
      <figcaption className="mb-1.5 text-xs text-slate-500 italic">
        {caption}
      </figcaption>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={caption}
          className="aspect-[4/3] w-full rounded-md border border-slate-200 bg-slate-50 object-cover"
        />
      ) : (
        <div className="flex aspect-[4/3] w-full items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50 text-xs text-slate-400">
          Not captured
        </div>
      )}
    </figure>
  )
}

function fmt(value: unknown) {
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "number")
    return Number.isInteger(value) ? String(value) : value.toFixed(1)
  return String(value)
}

function pct(value: unknown) {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : fmt(value)
}

function listOrDash(items?: string[] | null) {
  return items && items.length ? items.map(humanize).join(", ") : "—"
}

function findAssetId(
  assets: Array<Record<string, unknown>> | undefined,
  kind: string
) {
  const match = (assets || []).find((row) => String(row.kind || "") === kind)
  return typeof match?.asset_id === "string" ? match.asset_id : null
}

function formatBytes(bytes: number | null | undefined) {
  if (bytes == null || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

function filenameFromPath(filepath?: string) {
  if (!filepath) return "recording.mp4"
  const cleaned = filepath.split("?")[0] || filepath
  const parts = cleaned.split("/")
  return parts[parts.length - 1] || "recording.mp4"
}

function isAudioFile(file: EgressFile) {
  if (file.contentType?.startsWith("audio/")) return true
  const name = filenameFromPath(file.filepath).toLowerCase()
  return /\.(mp3|wav|m4a|aac|ogg)$/.test(name)
}

function EgressFilesPanel({ files }: { files: EgressFile[] }) {
  if (files.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No egress recordings yet. They appear after the room composite finishes
        uploading.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {files.map((file, index) => {
        const status = String(file.status || "unknown")
        const title =
          (file.role || "recording").replace(/_/g, " ") ||
          `Recording ${index + 1}`
        const filename = filenameFromPath(file.filepath)
        const sizeLabel = formatBytes(file.sizeBytes)
        const playable = Boolean(file.available && file.playableUrl)
        const audioOnly = isAudioFile(file)

        return (
          <div
            key={`${file.egress_id || file.filepath || index}`}
            className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50"
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900 capitalize">
                  {title}
                </p>
                <p className="mt-0.5 truncate font-mono text-xs text-slate-500">
                  {filename}
                  {sizeLabel ? ` · ${sizeLabel}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${
                    status === "started" || status === "complete"
                      ? "bg-emerald-50 text-emerald-700"
                      : status === "failed"
                        ? "bg-rose-500/10 text-rose-700"
                        : "bg-slate-200 text-slate-600"
                  }`}
                >
                  {status}
                </span>
                {file.downloadUrl ? (
                  <a
                    href={file.downloadUrl}
                    download={filename}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100"
                  >
                    Download
                  </a>
                ) : null}
              </div>
            </div>

            <div className="p-4">
              {playable && file.playableUrl ? (
                audioOnly ? (
                  <audio
                    controls
                    preload="metadata"
                    className="w-full"
                    src={file.playableUrl}
                  >
                    <track kind="captions" />
                  </audio>
                ) : (
                  <video
                    controls
                    playsInline
                    preload="metadata"
                    className="aspect-video w-full max-w-3xl rounded-lg bg-black object-contain"
                    src={file.playableUrl}
                  >
                    <track kind="captions" />
                  </video>
                )
              ) : status === "failed" ? (
                <p className="text-sm text-rose-600">
                  {file.detail ||
                    file.error ||
                    "Egress failed to start or upload."}
                </p>
              ) : (
                <p className="text-sm text-slate-500">
                  Recording is processing or not yet available in storage.
                  Refresh in a moment.
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SamVideoPreview({
  sessionId,
  overlayAssetId,
  clipAssetId,
}: {
  sessionId: string
  overlayAssetId?: string | null
  clipAssetId?: string | null
}) {
  const overlayUrl = overlayAssetId
    ? `/api/sessions/${sessionId}/assets/${overlayAssetId}`
    : null
  const clipUrl = clipAssetId
    ? `/api/sessions/${sessionId}/assets/${clipAssetId}`
    : null

  if (!overlayUrl && !clipUrl) {
    return (
      <p className="mt-4 text-xs text-slate-500">
        SAM preview video will appear here after egress segmentation finishes.
      </p>
    )
  }

  return (
    <div className="mt-4 space-y-3">
      {overlayUrl ? (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
              SAM overlay preview
            </p>
            <a
              href={overlayUrl}
              download="sam-overlay.mp4"
              className="text-xs font-semibold text-slate-700 hover:underline"
            >
              Download
            </a>
          </div>
          <video
            controls
            playsInline
            preload="metadata"
            className="aspect-video w-full max-w-3xl rounded-xl bg-black object-contain ring-1 ring-slate-200"
            src={overlayUrl}
          >
            <track kind="captions" />
          </video>
        </div>
      ) : null}
      {clipUrl ? (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
              SAM source clip
            </p>
            <a
              href={clipUrl}
              download="sam-clip.mp4"
              className="text-xs font-semibold text-slate-700 hover:underline"
            >
              Download
            </a>
          </div>
          <video
            controls
            playsInline
            preload="metadata"
            className="aspect-video w-full max-w-3xl rounded-xl bg-black object-contain ring-1 ring-slate-200"
            src={clipUrl}
          >
            <track kind="captions" />
          </video>
        </div>
      ) : null}
    </div>
  )
}
