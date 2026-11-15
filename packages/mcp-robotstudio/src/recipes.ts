/**
 * Anti-collision shield for recipe writes (PERS robtarget / pose / num).
 * A write is blocked BEFORE reaching the controller when:
 *  - the symbol is not PERS (checked by the caller with symbol properties);
 *  - the quaternion is not unit length;
 *  - the TCP jump from the current value exceeds deltaMaxMm;
 *  - the point is outside the IRB 120 envelope or not reachable (IK);
 *  - a num leaves [min, max] or jumps more than deltaMax.
 */
import {
  distance,
  inverseKinematics,
  isUnitQuat,
  orientationErrorDeg,
  type Pose,
  parsePoseLiteral,
  quatNorm,
} from "./kinematics/index.js";

export interface RecipeShieldOptions {
  deltaMaxMm?: number;
  deltaMaxDeg?: number;
  /** envelope radius from the base axis, mm (cell_config: 100..700) */
  minRadiusMm?: number;
  maxRadiusMm?: number;
  minZmm?: number;
  tool?: Pose;
  /** for num symbols */
  numMin?: number;
  numMax?: number;
}

export interface RecipeShieldResult {
  allowed: boolean;
  kind: "robtarget" | "num" | "other";
  reasons: string[];
  details: Record<string, unknown>;
}

export function checkRecipeWrite(
  dataType: string | null,
  currentValue: string | null,
  nextValue: string,
  opts: RecipeShieldOptions = {},
): RecipeShieldResult {
  const reasons: string[] = [];
  const details: Record<string, unknown> = {};
  const dt = (dataType ?? "").toLowerCase();

  if (dt === "num" || dt === "dnum") {
    const next = Number(nextValue);
    if (!Number.isFinite(next)) reasons.push(`"${nextValue}" is not a number`);
    if (opts.numMin !== undefined && next < opts.numMin) reasons.push(`${next} < min ${opts.numMin}`);
    if (opts.numMax !== undefined && next > opts.numMax) reasons.push(`${next} > max ${opts.numMax}`);
    const cur = Number(currentValue);
    if (opts.deltaMaxMm !== undefined && Number.isFinite(cur) && Math.abs(next - cur) > opts.deltaMaxMm) {
      reasons.push(`jump ${Math.abs(next - cur)} exceeds delta_max ${opts.deltaMaxMm}`);
    }
    return { allowed: reasons.length === 0, kind: "num", reasons, details: { current: cur, next } };
  }

  if (dt !== "robtarget" && dt !== "pose") {
    return { allowed: true, kind: "other", reasons, details: { note: `no geometric check for ${dataType ?? "unknown type"}` } };
  }

  let next: Pose;
  try {
    next = parsePoseLiteral(nextValue);
  } catch (e) {
    return { allowed: false, kind: "robtarget", reasons: [(e as Error).message], details };
  }
  const deltaMax = opts.deltaMaxMm ?? 50;
  const n = quatNorm(next.rot);
  details.quatNorm = n;
  if (!isUnitQuat(next.rot)) reasons.push(`quaternion not unit length (|q| = ${n.toFixed(6)})`);

  if (currentValue) {
    try {
      const cur = parsePoseLiteral(currentValue);
      const jump = distance(cur.trans, next.trans);
      details.jumpMm = jump;
      if (jump > deltaMax) reasons.push(`TCP jump ${jump.toFixed(1)} mm exceeds delta_max ${deltaMax} mm`);
      if (opts.deltaMaxDeg !== undefined && isUnitQuat(cur.rot) && isUnitQuat(next.rot)) {
        const dr = orientationErrorDeg(cur.rot, next.rot);
        details.rotationJumpDeg = dr;
        if (dr > opts.deltaMaxDeg) reasons.push(`orientation jump ${dr.toFixed(1)} deg exceeds ${opts.deltaMaxDeg} deg`);
      }
    } catch {
      details.currentUnparsed = true;
    }
  }

  const r = Math.hypot(next.trans[0], next.trans[1]);
  details.radiusMm = r;
  if (r < (opts.minRadiusMm ?? 100)) reasons.push(`radius ${r.toFixed(1)} mm inside the base clearance (${opts.minRadiusMm ?? 100} mm)`);
  if (r > (opts.maxRadiusMm ?? 700)) reasons.push(`radius ${r.toFixed(1)} mm outside the envelope (${opts.maxRadiusMm ?? 700} mm)`);
  if (opts.minZmm !== undefined && next.trans[2] < opts.minZmm) reasons.push(`z ${next.trans[2]} mm below floor ${opts.minZmm} mm`);

  if (isUnitQuat(next.rot)) {
    const ik = inverseKinematics(next, { tool: opts.tool });
    details.reachable = ik.reachable;
    if (ik.joints) details.joints = ik.joints.map((v) => Math.round(v * 100) / 100);
    if (!ik.reachable) reasons.push("target not reachable by the IRB 120 (offline IK)");
    else if (ik.check?.wrist.singular) reasons.push("target in wrist singularity (|q5| < 3 deg)");
  }
  return { allowed: reasons.length === 0, kind: "robtarget", reasons, details };
}
