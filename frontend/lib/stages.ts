export const STAGES = [
  { id: "precheck", label: "Lighting" },
  { id: "face", label: "Face" },
  { id: "liveness", label: "Liveness" },
  { id: "kyc", label: "KYC ID" },
  { id: "body_front", label: "Body front" },
  { id: "body_back", label: "Body back" },
  { id: "done", label: "Done" },
] as const

export type StageId = (typeof STAGES)[number]["id"]

export function isStageId(value: string): value is StageId {
  return STAGES.some((s) => s.id === value)
}

export function stageIndex(id: StageId): number {
  return STAGES.findIndex((s) => s.id === id)
}

export function defaultGuidance(id: StageId): string {
  switch (id) {
    case "precheck":
      return "Sit in good light, face the camera, shoulders visible."
    case "face":
      return "Hold still for a clear frontal selfie."
    case "liveness":
      return "Blink and slowly turn your head."
    case "kyc":
      return "Hold your government ID steady in frame."
    case "body_front":
      return "Stand back so your full body is visible from the front."
    case "body_back":
      return "Turn around for a full-body back view."
    default:
      return "Interview complete. You can end the call."
  }
}

export function assetKindForStage(id: StageId): string | null {
  switch (id) {
    case "precheck":
      return "precheck"
    case "face":
      return "face"
    case "liveness":
      return "liveness"
    case "kyc":
      return "kyc_id"
    case "body_front":
      return "body_front"
    case "body_back":
      return "body_back"
    default:
      return null
  }
}
