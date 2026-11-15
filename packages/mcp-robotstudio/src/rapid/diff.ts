/** Line diff (LCS) between the module in controller RAM and a Golden Master file. */
export interface DiffLine {
  op: "equal" | "add" | "remove";
  /** 1-based line in the golden file (remove/equal) */
  goldenLine?: number;
  /** 1-based line in the live module (add/equal) */
  liveLine?: number;
  text: string;
}

export interface ModuleDiff {
  identical: boolean;
  added: number;
  removed: number;
  lines: DiffLine[];
  /** unified-style text with only the changed lines and `context` lines around them */
  unified: string;
}

export function normalizeRapidText(text: string, ignoreWhitespace: boolean): string[] {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return ignoreWhitespace ? lines.map((l) => l.trim().replace(/\s+/g, " ")) : lines.map((l) => l.replace(/\s+$/, ""));
}

export function diffModules(golden: string, live: string, opts: { ignoreWhitespace?: boolean; context?: number } = {}): ModuleDiff {
  const ignore = opts.ignoreWhitespace ?? true;
  const context = opts.context ?? 2;
  const a = normalizeRapidText(golden, ignore);
  const b = normalizeRapidText(live, ignore);
  const aRaw = normalizeRapidText(golden, false);
  const bRaw = normalizeRapidText(live, false);
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ op: "equal", goldenLine: i + 1, liveLine: j + 1, text: bRaw[j]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ op: "remove", goldenLine: i + 1, text: aRaw[i]! });
      i++;
    } else {
      lines.push({ op: "add", liveLine: j + 1, text: bRaw[j]! });
      j++;
    }
  }
  for (; i < n; i++) lines.push({ op: "remove", goldenLine: i + 1, text: aRaw[i]! });
  for (; j < m; j++) lines.push({ op: "add", liveLine: j + 1, text: bRaw[j]! });

  const added = lines.filter((l) => l.op === "add").length;
  const removed = lines.filter((l) => l.op === "remove").length;
  const keep = new Set<number>();
  lines.forEach((l, k) => {
    if (l.op !== "equal") for (let c = k - context; c <= k + context; c++) keep.add(c);
  });
  const out: string[] = [];
  let last = -2;
  lines.forEach((l, k) => {
    if (!keep.has(k)) return;
    if (k !== last + 1) out.push(`@@ golden ${l.goldenLine ?? "-"} / live ${l.liveLine ?? "-"} @@`);
    out.push(`${l.op === "add" ? "+" : l.op === "remove" ? "-" : " "} ${l.text}`);
    last = k;
  });
  return { identical: added === 0 && removed === 0, added, removed, lines, unified: out.join("\n") };
}
