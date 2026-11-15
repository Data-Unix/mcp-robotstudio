/**
 * IRB 120-3/0.58 kinematics and RAPID pose math, ported from
 * include/mcp_robotstudio/safety/kinematic_safety_filter.h and extended.
 *
 * Conventions (RAPID): positions in mm, quaternions [q1,q2,q3,q4] = [w,x,y,z],
 * joint angles in degrees. Forward kinematics is a product of exponentials whose
 * zero pose is tool0 = [374, 0, 630] with q = [0.70711, 0, 0.70711, 0]; checked
 * live on RobotWare 6.16 at joints [0,0,0,0,30,0] -> [364.3538, 0, 594.0001],
 * q = [0.5, 0, 0.8660254, 0].
 */
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];
export type Joints = [number, number, number, number, number, number];

export interface Pose {
  trans: Vec3;
  rot: Quat;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// --------------------------------------------------------------------------
// Quaternion / rotation helpers
// --------------------------------------------------------------------------
export function quatNorm(q: Quat): number {
  return Math.hypot(q[0], q[1], q[2], q[3]);
}

/** RAPID NOrient: normalizes an orientation. */
export function nOrient(q: Quat): Quat {
  const n = quatNorm(q);
  if (n === 0) throw new Error("zero quaternion cannot be normalized");
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** RAPID accepts orientations whose norm deviates by less than ~0.00001 after NOrient; we flag > tol. */
export function isUnitQuat(q: Quat, tol = 1e-4): boolean {
  return Math.abs(quatNorm(q) - 1) <= tol;
}

export function quatMul(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function quatConj(q: Quat): Quat {
  return [q[0], -q[1], -q[2], -q[3]];
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const p = quatMul(quatMul(q, [0, v[0], v[1], v[2]]), quatConj(q));
  return [p[1], p[2], p[3]];
}

export function quatToMat(q: Quat): Mat3 {
  const [w, x, y, z] = nOrient(q);
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

export function matToQuat(m: Mat3): Quat {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s];
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    q = [(m[2][1] - m[1][2]) / s, 0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s];
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    q = [(m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s];
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    q = [(m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s];
  }
  q = nOrient(q);
  // Canonical sign: q1 >= 0 (same as the controller for q and -q).
  return q[0] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

function axisAngle(axis: Vec3, deg: number): Quat {
  const h = (deg * D2R) / 2;
  const s = Math.sin(h);
  return [Math.cos(h), axis[0] * s, axis[1] * s, axis[2] * s];
}

/** RAPID OrientZYX(Anglez, Angley, Anglex): rotation Z, then Y, then X (degrees). */
export function orientZYX(ez: number, ey: number, ex: number): Quat {
  return matToQuat(
    quatToMat(quatMul(quatMul(axisAngle([0, 0, 1], ez), axisAngle([0, 1, 0], ey)), axisAngle([1, 0, 0], ex))),
  );
}

/** RAPID EulerZYX(\X|\Y|\Z, Rotation): the Euler ZYX angles (deg) of an orientation. */
export function eulerZYX(q: Quat): { z: number; y: number; x: number } {
  const m = quatToMat(q);
  const sy = -m[2][0];
  const y = Math.asin(Math.max(-1, Math.min(1, sy)));
  let z: number;
  let x: number;
  if (Math.abs(sy) > 0.999999) {
    // gimbal lock: put everything on z
    x = 0;
    z = Math.atan2(-m[0][1], m[1][1]);
  } else {
    z = Math.atan2(m[1][0], m[0][0]);
    x = Math.atan2(m[2][1], m[2][2]);
  }
  return { z: z * R2D, y: y * R2D, x: x * R2D };
}

/** RAPID PoseMult(pose1, pose2) = pose1 * pose2. */
export function poseMult(a: Pose, b: Pose): Pose {
  const t = quatRotate(a.rot, b.trans);
  return {
    trans: [a.trans[0] + t[0], a.trans[1] + t[1], a.trans[2] + t[2]],
    rot: nOrient(quatMul(a.rot, b.rot)),
  };
}

/** RAPID PoseInv. */
export function poseInv(p: Pose): Pose {
  const r = quatConj(nOrient(p.rot));
  const t = quatRotate(r, p.trans);
  return { trans: [-t[0], -t[1], -t[2]], rot: r };
}

/** RAPID Offs(p, dx, dy, dz): displacement in the work object frame. */
export function offs(p: Pose, dx: number, dy: number, dz: number): Pose {
  return { trans: [p.trans[0] + dx, p.trans[1] + dy, p.trans[2] + dz], rot: p.rot };
}

/** RAPID RelTool(p, dx, dy, dz): displacement in the tool frame. */
export function relTool(p: Pose, dx: number, dy: number, dz: number): Pose {
  return poseMult(p, { trans: [dx, dy, dz], rot: [1, 0, 0, 0] });
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Angle between two orientations, degrees. */
export function orientationErrorDeg(a: Quat, b: Quat): number {
  const d = Math.abs(quatMul(quatConj(nOrient(a)), nOrient(b))[0]);
  return 2 * Math.acos(Math.min(1, d)) * R2D;
}

// --------------------------------------------------------------------------
// IRB 120-3/0.58 model
// --------------------------------------------------------------------------
export interface JointLimit {
  min: number;
  max: number;
  maxVel: number;
}

/** Working range from SYSPAR/MOC.cfg of the live controller (config/cell_config.json). */
export const IRB120_LIMITS: JointLimit[] = [
  { min: -165, max: 165, maxVel: 250 },
  { min: -110, max: 110, maxVel: 250 },
  { min: -110, max: 70, maxVel: 250 },
  { min: -160, max: 160, maxVel: 320 },
  { min: -120, max: 120, maxVel: 320 },
  { min: -400, max: 400, maxVel: 420 },
];

/** Link lengths (mm): base 290, upper arm 270, elbow offset 70, forearm 302, flange 72. */
export const IRB120_GEOMETRY = { d1: 290, a2: 270, a3: 70, d4: 302, d6: 72 } as const;

const G = IRB120_GEOMETRY;
// Screw axes at zero pose: [axis, point on axis].
const AXES: Array<[Vec3, Vec3]> = [
  [[0, 0, 1], [0, 0, 0]],
  [[0, 1, 0], [0, 0, G.d1]],
  [[0, 1, 0], [0, 0, G.d1 + G.a2]],
  [[1, 0, 0], [0, 0, G.d1 + G.a2 + G.a3]],
  [[0, 1, 0], [G.d4, 0, G.d1 + G.a2 + G.a3]],
  [[1, 0, 0], [0, 0, G.d1 + G.a2 + G.a3]],
];
const HOME: Pose = {
  trans: [G.d4 + G.d6, 0, G.d1 + G.a2 + G.a3],
  rot: [Math.SQRT1_2, 0, Math.SQRT1_2, 0],
};

/** Pose of a rotation `deg` about the line (axis through point). */
function screw(axis: Vec3, point: Vec3, deg: number): Pose {
  const rot = axisAngle(axis, deg);
  const rp = quatRotate(rot, point);
  return { trans: [point[0] - rp[0], point[1] - rp[1], point[2] - rp[2]], rot };
}

/** Flange (tool0) pose in base/world frame. */
export function forwardKinematics(j: Joints, tool?: Pose): Pose {
  let t: Pose = { trans: [0, 0, 0], rot: [1, 0, 0, 0] };
  for (let i = 0; i < 6; i++) t = poseMult(t, screw(AXES[i]![0], AXES[i]![1], j[i]!));
  const flange = poseMult(t, HOME);
  const out = tool ? poseMult(flange, tool) : flange;
  return { trans: out.trans, rot: matToQuat(quatToMat(out.rot)) };
}

/** Geometric Jacobian (6x6): rows vx,vy,vz (m/rad), wx,wy,wz. */
export function jacobian(j: Joints): number[][] {
  const J: number[][] = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  const tcp = forwardKinematics(j).trans;
  let t: Pose = { trans: [0, 0, 0], rot: [1, 0, 0, 0] };
  for (let i = 0; i < 6; i++) {
    const w = quatRotate(t.rot, AXES[i]![0]);
    const pr = quatRotate(t.rot, AXES[i]![1]);
    const p: Vec3 = [pr[0] + t.trans[0], pr[1] + t.trans[1], pr[2] + t.trans[2]];
    const r: Vec3 = [(tcp[0] - p[0]) / 1000, (tcp[1] - p[1]) / 1000, (tcp[2] - p[2]) / 1000];
    const v: Vec3 = [w[1] * r[2] - w[2] * r[1], w[2] * r[0] - w[0] * r[2], w[0] * r[1] - w[1] * r[0]];
    for (let k = 0; k < 3; k++) {
      J[k]![i] = v[k]!;
      J[k + 3]![i] = w[k]!;
    }
    t = poseMult(t, screw(AXES[i]![0], AXES[i]![1], j[i]!));
  }
  return J;
}

function det(m: number[][]): number {
  const n = m.length;
  const a = m.map((r) => [...r]);
  let d = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    if (Math.abs(a[p]![c]!) < 1e-15) return 0;
    if (p !== c) {
      [a[p], a[c]] = [a[c]!, a[p]!];
      d = -d;
    }
    d *= a[c]![c]!;
    for (let r = c + 1; r < n; r++) {
      const f = a[r]![c]! / a[c]![c]!;
      for (let k = c; k < n; k++) a[r]![k]! -= f * a[c]![k]!;
    }
  }
  return d;
}

/** Yoshikawa manipulability w = sqrt(det(J * J^T)), J in m/rad. */
export function manipulability(j: Joints): number {
  const J = jacobian(j);
  const JJt = J.map((ri) => J.map((rj) => ri.reduce((s, v, k) => s + v * rj[k]!, 0)));
  return Math.sqrt(Math.max(0, det(JJt)));
}

/** q3 at which the wrist centre lines up with the upper arm (arm fully stretched). */
export const IRB120_ELBOW_STRETCH_Q3 = -Math.atan2(G.d4, G.a3) * R2D; // about -77.05 deg

export interface SafetyThresholds {
  wristDeg: number;
  elbowDeg: number;
  /** relative manipulability (w / w at the reference pose) below which a warning is raised */
  manipulabilityRel: number;
}

export const DEFAULT_THRESHOLDS: SafetyThresholds = { wristDeg: 3, elbowDeg: 5, manipulabilityRel: 0.05 };

// Reference w at a well-conditioned pose, used to normalise the index.
const W_REF = manipulability([0, 0, 0, 0, 45, 0]);

export interface JointCheck {
  safe: boolean;
  reason?: string;
  warnings: string[];
  limitViolations: Array<{ axis: number; value: number; min: number; max: number }>;
  /** fraction of the range used on each axis (0 centre, 1 at a limit) */
  limitUsage: number[];
  wrist: { singular: boolean; distanceDeg: number };
  elbow: { singular: boolean; distanceDeg: number };
  manipulability: number;
  manipulabilityRel: number;
}

export function checkJoints(j: number[], th: SafetyThresholds = DEFAULT_THRESHOLDS, limits = IRB120_LIMITS): JointCheck {
  if (j.length !== 6 || j.some((v) => !Number.isFinite(v))) {
    throw new Error(`expected 6 finite joint values, got ${JSON.stringify(j)}`);
  }
  const jj = j as Joints;
  const warnings: string[] = [];
  const limitViolations: JointCheck["limitViolations"] = [];
  const limitUsage = jj.map((v, i) => {
    const l = limits[i]!;
    if (v < l.min || v > l.max) limitViolations.push({ axis: i + 1, value: v, min: l.min, max: l.max });
    const mid = (l.max + l.min) / 2;
    return Math.min(1.5, Math.abs(v - mid) / ((l.max - l.min) / 2));
  });
  const wristDist = Math.abs(jj[4]);
  const elbowDist = Math.abs(jj[2] - IRB120_ELBOW_STRETCH_Q3);
  const w = manipulability(jj);
  const wRel = w / W_REF;
  const wrist = { singular: wristDist < th.wristDeg, distanceDeg: wristDist };
  const elbow = { singular: elbowDist < th.elbowDeg, distanceDeg: elbowDist };
  if (elbow.singular) warnings.push(`elbow near stretch singularity (|q3 - ${IRB120_ELBOW_STRETCH_Q3.toFixed(2)}| = ${elbowDist.toFixed(2)} deg)`);
  if (wRel < th.manipulabilityRel) warnings.push(`low manipulability (relative ${wRel.toFixed(4)})`);
  let reason: string | undefined;
  if (limitViolations.length > 0) {
    const v = limitViolations[0]!;
    reason = `Joint ${v.axis} target ${v.value} deg exceeds limits [${v.min}, ${v.max}] deg`;
  } else if (wrist.singular) {
    reason = `Wrist singularity (|q5| = ${wristDist.toFixed(3)} deg < ${th.wristDeg} deg)`;
  }
  return {
    safe: reason === undefined,
    ...(reason ? { reason } : {}),
    warnings,
    limitViolations,
    limitUsage,
    wrist,
    elbow,
    manipulability: w,
    manipulabilityRel: wRel,
  };
}

// --------------------------------------------------------------------------
// Inverse kinematics (numeric, damped least squares) for reach probing
// --------------------------------------------------------------------------
export interface IkResult {
  reachable: boolean;
  joints?: Joints;
  positionErrorMm: number;
  orientationErrorDeg: number;
  check?: JointCheck;
}

function solve6(A: number[][], b: number[]): number[] {
  const n = 6;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[p], M[c]] = [M[c]!, M[p]!];
    const piv = M[c]![c]! || 1e-12;
    for (let k = c; k <= n; k++) M[c]![k]! /= piv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((r) => r[n]!);
}

const SEEDS: Joints[] = [
  [0, 0, 0, 0, 30, 0],
  [0, 20, 10, 0, 60, 0],
  [0, -20, 30, 0, 45, 0],
  [0, 40, -20, 0, 70, 0],
  [0, 10, 20, 90, -60, -90],
  [0, 30, 0, 0, -45, 180],
];

/**
 * Solves tool0/tool pose -> joints without moving the robot (same purpose as
 * RAPID CalcJointT, but offline). Tries several seeds; returns the first
 * solution within tolerance that respects joint limits, preferring larger |q5|.
 */
export function inverseKinematics(target: Pose, opts: { tool?: Pose; seed?: number[]; posTolMm?: number; rotTolDeg?: number } = {}): IkResult {
  const posTol = opts.posTolMm ?? 0.5;
  const rotTol = opts.rotTolDeg ?? 0.1;
  const goal = target.rot;
  if (!isUnitQuat(goal, 1e-3)) {
    return { reachable: false, positionErrorMm: NaN, orientationErrorDeg: NaN };
  }
  const seeds = opts.seed && opts.seed.length === 6 ? [opts.seed as Joints, ...SEEDS] : SEEDS;
  // seed J1 towards the target
  const j1 = Math.atan2(target.trans[1], target.trans[0]) * R2D;
  let best: IkResult = { reachable: false, positionErrorMm: Infinity, orientationErrorDeg: Infinity };
  for (const s0 of seeds) {
    const q: Joints = [...s0] as Joints;
    if (s0 === SEEDS[0] || !opts.seed) q[0] = j1;
    for (let it = 0; it < 200; it++) {
      const cur = forwardKinematics(q, opts.tool);
      const ep: Vec3 = [
        (target.trans[0] - cur.trans[0]) / 1000,
        (target.trans[1] - cur.trans[1]) / 1000,
        (target.trans[2] - cur.trans[2]) / 1000,
      ];
      let dq = quatMul(nOrient(goal), quatConj(cur.rot));
      if (dq[0] < 0) dq = [-dq[0], -dq[1], -dq[2], -dq[3]];
      const eo: Vec3 = [2 * dq[1], 2 * dq[2], 2 * dq[3]];
      const e = [...ep, ...eo];
      const posErr = Math.hypot(...ep) * 1000;
      const rotErr = orientationErrorDeg(goal, cur.rot);
      if (posErr < 0.005 && rotErr < 0.005) break;
      const J = jacobian(q);
      const lambda = 0.01;
      const JJt = J.map((ri, a) => J.map((rj, b) => ri.reduce((s, v, k) => s + v * rj[k]!, 0) + (a === b ? lambda * lambda : 0)));
      const y = solve6(JJt, e);
      for (let k = 0; k < 6; k++) {
        const step = J.reduce((s, row, r) => s + row[k]! * y[r]!, 0) * R2D;
        q[k] = q[k]! + Math.max(-10, Math.min(10, step));
      }
    }
    const fin = forwardKinematics(q, opts.tool);
    const pe = distance(fin.trans, target.trans);
    const re = orientationErrorDeg(goal, fin.rot);
    const wrap = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;
    let norm = q.map((v, i) => (i === 3 || i === 5 ? wrap(v) : v)) as Joints;
    // Same flange pose with the wrist flipped: (q4 +- 180, -q5, q6 +- 180).
    if (checkJoints(norm).limitViolations.length > 0) {
      const flip = [norm[0], norm[1], norm[2], wrap(norm[3] + 180), -norm[4], wrap(norm[5] + 180)] as Joints;
      if (checkJoints(flip).limitViolations.length === 0) norm = flip;
    }
    const check = checkJoints(norm);
    const ok = pe < posTol && re < rotTol && check.limitViolations.length === 0;
    const cand: IkResult = { reachable: ok, joints: norm, positionErrorMm: pe, orientationErrorDeg: re, check };
    const better =
      (cand.reachable && !best.reachable) ||
      (cand.reachable === best.reachable &&
        (cand.reachable
          ? Math.abs(norm[4]) > Math.abs(best.joints?.[4] ?? 0)
          : pe + re < best.positionErrorMm + best.orientationErrorDeg));
    if (better) best = cand;
    if (best.reachable && !best.check?.wrist.singular) break;
  }
  return best;
}

/** Robot configuration data (cf1, cf4, cf6, cfx) of a joint solution, RAPID quadrant convention. */
export function confData(j: Joints): [number, number, number, number] {
  const quad = (deg: number) => Math.floor(deg / 90);
  return [quad(j[0]), quad(j[3]), quad(j[5]), 0];
}

/** Parses "[[x,y,z],[q1,q2,q3,q4],...]" (robtarget or pose literal). */
export function parsePoseLiteral(text: string): Pose {
  const nums = text.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
  if (nums.length < 7) throw new Error(`not a pose/robtarget literal: ${text}`);
  return { trans: [nums[0]!, nums[1]!, nums[2]!], rot: [nums[3]!, nums[4]!, nums[5]!, nums[6]!] };
}
