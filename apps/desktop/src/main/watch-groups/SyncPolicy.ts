export interface CorrectionInput {
  readonly targetMs: number;
  readonly actualMs: number;
  readonly playing: boolean;
  readonly adjustingRate: boolean;
  readonly forceAlignment: boolean;
}
export type Correction =
  | { readonly type: "rate"; readonly rate: number }
  | { readonly type: "seek"; readonly positionMs: number };

export const chooseCorrection = (input: CorrectionInput): Correction => {
  const drift = input.targetMs - input.actualMs;
  const distance = Math.abs(drift);
  if (input.forceAlignment || (!input.playing && distance > 80) || distance >= 1_000)
    return { type: "seek", positionMs: input.targetMs };
  if (!input.playing || distance <= 80 || (!input.adjustingRate && distance <= 120))
    return { type: "rate", rate: 1 };
  return { type: "rate", rate: 1 + Math.max(-0.05, Math.min(0.05, drift / 10_000)) };
};
