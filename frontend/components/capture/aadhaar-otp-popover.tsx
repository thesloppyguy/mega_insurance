"use client"

import { OTPInput, OTPInputContext } from "input-otp"
import { useContext, type ComponentPropsWithoutRef } from "react"

type OtpMeta = {
  length: number
  hint: string
  aadhaar_number?: string
}

type Props = {
  meta: OtpMeta
  code: string
  onCodeChange: (value: string) => void
  submitting?: boolean
  requesting?: boolean
  requestError?: string | null
  otpRequested?: boolean
  resending?: boolean
  resendCooldownSeconds?: number
  canResend?: boolean
  onSubmit: () => void
  onResend: () => void
  onCancel: () => void
}

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ")
}

function InputOTP({
  className,
  containerClassName,
  ...props
}: ComponentPropsWithoutRef<typeof OTPInput>) {
  return (
    <OTPInput
      containerClassName={cn(
        "flex items-center gap-2 has-disabled:opacity-50",
        containerClassName
      )}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  )
}

function InputOTPGroup({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("flex items-center", className)} {...props} />
}

function InputOTPSlot({
  index,
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { index: number }) {
  const ctx = useContext(OTPInputContext)
  const slot = ctx.slots[index]
  if (!slot) return null
  const { char, isActive, hasFakeCaret } = slot

  return (
    <div
      className={cn(
        "relative flex size-10 items-center justify-center border border-zinc-200 bg-zinc-50 text-lg font-semibold text-zinc-900 shadow-sm transition-all first:rounded-l-md last:rounded-r-md",
        isActive && "z-10 border-teal-500 ring-1 ring-teal-500/40",
        className
      )}
      {...props}
    >
      {char}
      {hasFakeCaret ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-px animate-pulse bg-zinc-800" />
        </div>
      ) : null}
    </div>
  )
}

function InputOTPSeparator(props: ComponentPropsWithoutRef<"div">) {
  return (
    <div role="separator" className="px-1 text-zinc-400" {...props}>
      –
    </div>
  )
}

function OtpSlots({ length }: { length: number }) {
  const slots = Array.from({ length }, (_, index) => index)
  const midpoint = Math.ceil(length / 2)

  if (length === 6) {
    return (
      <>
        <InputOTPGroup>
          {slots.slice(0, 3).map((index) => (
            <InputOTPSlot key={index} index={index} />
          ))}
        </InputOTPGroup>
        <InputOTPSeparator className="opacity-40" />
        <InputOTPGroup>
          {slots.slice(3).map((index) => (
            <InputOTPSlot key={index} index={index} />
          ))}
        </InputOTPGroup>
      </>
    )
  }

  return (
    <>
      <InputOTPGroup>
        {slots.slice(0, midpoint).map((index) => (
          <InputOTPSlot key={index} index={index} />
        ))}
      </InputOTPGroup>
      {length > 4 ? <InputOTPSeparator className="opacity-40" /> : null}
      {length > 4 ? (
        <InputOTPGroup>
          {slots.slice(midpoint).map((index) => (
            <InputOTPSlot key={index} index={index} />
          ))}
        </InputOTPGroup>
      ) : null}
    </>
  )
}

function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-4 animate-spin rounded-full border-2 border-current/30 border-t-current",
        className
      )}
    />
  )
}

/** Aadhaar OTP dialog — Deepvue OKYC generate + verify. */
export function AadhaarOtpPopover({
  meta,
  code,
  onCodeChange,
  submitting = false,
  requesting = false,
  requestError = null,
  otpRequested = false,
  resending = false,
  resendCooldownSeconds = 0,
  canResend = false,
  onSubmit,
  onResend,
  onCancel,
}: Props) {
  const last4 = meta.aadhaar_number?.slice(-4) ?? ""
  const description =
    meta.hint ||
    (last4
      ? `Enter the ${meta.length}-digit OTP sent to the mobile number linked with Aadhaar ending in ${last4}.`
      : `Enter the ${meta.length}-digit Aadhaar OTP sent via SMS.`)

  const inputDisabled = submitting || requesting || !otpRequested
  const verifyDisabled =
    code.length !== meta.length || submitting || requesting || !otpRequested

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="aadhaar-otp-input-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/80 p-4 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-md flex-col gap-5 rounded-xl border border-zinc-200 bg-white p-5 shadow-xl">
        <div>
          <h2
            id="aadhaar-otp-input-title"
            className="text-lg font-semibold text-zinc-900"
          >
            Verify Aadhaar OTP
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            {requesting ? "Requesting OTP from UIDAI…" : description}
          </p>
          {requestError ? (
            <p className="mt-2 text-sm text-rose-600">{requestError}</p>
          ) : null}
        </div>

        <div className="flex justify-center">
          <InputOTP
            maxLength={meta.length}
            value={code}
            onChange={onCodeChange}
            autoComplete="one-time-code"
            disabled={inputDisabled}
            inputMode="numeric"
          >
            <OtpSlots length={meta.length} />
          </InputOTP>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg bg-teal-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-600 disabled:opacity-50"
              disabled={verifyDisabled}
              onClick={onSubmit}
            >
              {submitting ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner className="border-white/30 border-t-white text-white" />
                  Verify
                </span>
              ) : (
                "Verify"
              )}
            </button>
            <button
              type="button"
              className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              disabled={!canResend}
              onClick={onResend}
            >
              {resending || requesting ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner />
                  {resendCooldownSeconds > 0
                    ? `Resend (${resendCooldownSeconds}s)`
                    : "Resend"}
                </span>
              ) : resendCooldownSeconds > 0 ? (
                `Resend (${resendCooldownSeconds}s)`
              ) : (
                "Resend"
              )}
            </button>
          </div>
          <button
            type="button"
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-zinc-500 hover:text-zinc-800 disabled:opacity-50"
            disabled={submitting}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
