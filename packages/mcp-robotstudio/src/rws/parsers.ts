export interface RwsErrorDetail {
  code?: string;
  msg?: string;
}

export interface SystemInfo {
  name: string | null;
  rwversion: string | null;
  rwversionname: string | null;
  sysid: string | null;
  starttm: string | null;
  options: string[];
}

export interface PanelState {
  ctrlstate: string | null;
  opmode: string | null;
  ctrlexecstate: string | null;
  cycle: string | null;
}

export interface RapidTaskInfo {
  name: string;
  type: string | null;
  taskstate: string | null;
  excstate: string | null;
  active: string | null;
  motiontask: string | null;
}

export interface RapidModuleInfo {
  name: string;
  type: string | null;
}

export interface IoSignalInfo {
  name: string;
  type: string | null;
  category: string | null;
  value: string | null;
  state: string | null;
  unit?: string | null;
  physicalState?: string | null;
  physicalValue?: string | null;
  quality?: string | null;
}

export interface EventLogEntry {
  code: string | null;
  type: string | null;
  src: string | null;
  time: string | null;
  title: string | null;
  desc: string;
  conseqs: string;
  causes: string;
  actions: string;
}

export interface JointTargetInfo {
  rax_1: number | null;
  rax_2: number | null;
  rax_3: number | null;
  rax_4: number | null;
  rax_5: number | null;
  rax_6: number | null;
  eax_a: number | null;
  eax_b: number | null;
  eax_c: number | null;
  eax_d: number | null;
  eax_e: number | null;
  eax_f: number | null;
  jointsDeg: number[];
}

export interface RobTargetInfo {
  x: number | null;
  y: number | null;
  z: number | null;
  q1: number | null;
  q2: number | null;
  q3: number | null;
  q4: number | null;
  cf1: number | null;
  cf4: number | null;
  cf6: number | null;
  cfx: number | null;
}

export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractSpan(xml: string, className: string): string | null {
  const re = new RegExp(`<span\\b[^>]*\\bclass="${className}"[^>]*>([^<]*)<`, "i");
  const m = re.exec(xml);
  if (!m) return null;
  return decodeXmlEntities((m[1] ?? "").trim());
}

function extractAllSpans(xml: string, className: string): string[] {
  const re = new RegExp(`<span\\b[^>]*\\bclass="${className}"[^>]*>([^<]*)<`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(decodeXmlEntities((m[1] ?? "").trim()));
  }
  return out;
}

function extractListBlocks(xml: string, liClass: string): string[] {
  const re = new RegExp(`<li\\s+class="${liClass}"[^>]*>[\\s\\S]*?</li>`, "gi");
  return xml.match(re) ?? [];
}

function toFiniteNumber(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseRwsErrorBody(body: string): RwsErrorDetail {
  const code = extractSpan(body, "code") ?? undefined;
  const msg = extractSpan(body, "msg") ?? undefined;
  if (code || msg) {
    return { code, msg };
  }

  // Fallback for plain text responses (e.g. 401 Access Denied, 503 Too many sessions,
  // or raw cpp Rejected strings).
  const rejectedCode = /Rejected\s+code:(-?\d+)/i.exec(body)?.[1];
  const plain = decodeXmlEntities(body.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

  if (rejectedCode) {
    return { code: rejectedCode, msg: plain || body.trim() };
  }
  return { msg: plain || undefined };
}

export function parseSystemXml(xml: string): SystemInfo {
  const sysBlock = extractListBlocks(xml, "sys-system-li")[0] ?? xml;
  return {
    name: extractSpan(sysBlock, "name"),
    rwversion: extractSpan(sysBlock, "rwversion"),
    rwversionname: extractSpan(sysBlock, "rwversionname"),
    sysid: extractSpan(sysBlock, "sysid"),
    starttm: extractSpan(sysBlock, "starttm"),
    options: extractAllSpans(xml, "option"),
  };
}

export function parseCtrlStateXml(xml: string): { ctrlstate: string | null } {
  return { ctrlstate: extractSpan(xml, "ctrlstate") };
}

export function parseOpModeXml(xml: string): { opmode: string | null } {
  return { opmode: extractSpan(xml, "opmode") };
}

export function parseExecutionXml(xml: string): {
  ctrlexecstate: string | null;
  cycle: string | null;
} {
  return {
    ctrlexecstate: extractSpan(xml, "ctrlexecstate"),
    cycle: extractSpan(xml, "cycle"),
  };
}

export function parseTasksXml(xml: string): { tasks: RapidTaskInfo[] } {
  const blocks = extractListBlocks(xml, "rap-task-li");
  const tasks: RapidTaskInfo[] = [];
  for (const block of blocks) {
    const name = extractSpan(block, "name");
    if (!name) continue;
    tasks.push({
      name,
      type: extractSpan(block, "type"),
      taskstate: extractSpan(block, "taskstate"),
      excstate: extractSpan(block, "excstate"),
      active: extractSpan(block, "active"),
      motiontask: extractSpan(block, "motiontask"),
    });
  }
  return { tasks };
}

export function parseModulesXml(xml: string): {
  modules: string[];
  items: RapidModuleInfo[];
} {
  const blocks = extractListBlocks(xml, "rap-module-info-li");
  const items: RapidModuleInfo[] = [];
  if (blocks.length > 0) {
    for (const block of blocks) {
      const name = extractSpan(block, "name");
      if (!name) continue;
      items.push({ name, type: extractSpan(block, "type") });
    }
  } else {
    for (const name of extractAllSpans(xml, "name")) {
      items.push({ name, type: null });
    }
  }
  return {
    modules: items.map((i) => i.name),
    items,
  };
}

export function parseSymbolXml(xml: string): { value: string | null } {
  return { value: extractSpan(xml, "value") };
}

export function parseSignalsListXml(xml: string): {
  signals: IoSignalInfo[];
  hasNext: boolean;
  nextHref: string | null;
} {
  const nextMatch = /<a\s+href="([^"]+)"\s+rel="next"/i.exec(xml);
  const nextHref = nextMatch?.[1] ? decodeXmlEntities(nextMatch[1]) : null;
  const blocks = extractListBlocks(xml, "ios-signal-li");
  const signals: IoSignalInfo[] = [];

  for (const block of blocks) {
    const name = extractSpan(block, "name");
    if (!name) continue;
    signals.push({
      name,
      type: extractSpan(block, "type"),
      category: extractSpan(block, "category"),
      value: extractSpan(block, "lvalue"),
      state: extractSpan(block, "lstate"),
    });
  }

  return {
    signals,
    hasNext: nextHref !== null,
    nextHref,
  };
}

export function parseSingleSignalXml(xml: string, fallbackName?: string): IoSignalInfo {
  const block = extractListBlocks(xml, "ios-signal")[0] ?? xml;
  return {
    name: extractSpan(block, "name") ?? fallbackName ?? "",
    type: extractSpan(block, "type"),
    category: extractSpan(block, "category"),
    value: extractSpan(block, "lvalue"),
    state: extractSpan(block, "lstate"),
    unit: extractSpan(block, "unitnm"),
    physicalState: extractSpan(block, "phstate"),
    physicalValue: extractSpan(block, "pvalue"),
    quality: extractSpan(block, "quality"),
  };
}

export function parseEventLogXml(xml: string, limit?: number): { events: EventLogEntry[] } {
  const blocks = extractListBlocks(xml, "elog-message-li");
  const sliced = typeof limit === "number" && limit >= 0 ? blocks.slice(0, limit) : blocks;
  const events: EventLogEntry[] = sliced.map((block) => ({
    code: extractSpan(block, "code"),
    type: extractSpan(block, "msgtype"),
    src: extractSpan(block, "src-name"),
    time: extractSpan(block, "tstamp"),
    title: extractSpan(block, "title"),
    desc: extractSpan(block, "desc") ?? "",
    conseqs: extractSpan(block, "conseqs") ?? "",
    causes: extractSpan(block, "causes") ?? "",
    actions: extractSpan(block, "actions") ?? "",
  }));
  return { events };
}

export function parseJointTargetXml(xml: string): JointTargetInfo {
  const rax_1 = toFiniteNumber(extractSpan(xml, "rax_1"));
  const rax_2 = toFiniteNumber(extractSpan(xml, "rax_2"));
  const rax_3 = toFiniteNumber(extractSpan(xml, "rax_3"));
  const rax_4 = toFiniteNumber(extractSpan(xml, "rax_4"));
  const rax_5 = toFiniteNumber(extractSpan(xml, "rax_5"));
  const rax_6 = toFiniteNumber(extractSpan(xml, "rax_6"));
  const jointsDeg = [rax_1, rax_2, rax_3, rax_4, rax_5, rax_6].filter(
    (v): v is number => v !== null,
  );
  return {
    rax_1,
    rax_2,
    rax_3,
    rax_4,
    rax_5,
    rax_6,
    eax_a: toFiniteNumber(extractSpan(xml, "eax_a")),
    eax_b: toFiniteNumber(extractSpan(xml, "eax_b")),
    eax_c: toFiniteNumber(extractSpan(xml, "eax_c")),
    eax_d: toFiniteNumber(extractSpan(xml, "eax_d")),
    eax_e: toFiniteNumber(extractSpan(xml, "eax_e")),
    eax_f: toFiniteNumber(extractSpan(xml, "eax_f")),
    jointsDeg,
  };
}

export function parseRobTargetXml(xml: string): RobTargetInfo {
  return {
    x: toFiniteNumber(extractSpan(xml, "x")),
    y: toFiniteNumber(extractSpan(xml, "y")),
    z: toFiniteNumber(extractSpan(xml, "z")),
    q1: toFiniteNumber(extractSpan(xml, "q1")),
    q2: toFiniteNumber(extractSpan(xml, "q2")),
    q3: toFiniteNumber(extractSpan(xml, "q3")),
    q4: toFiniteNumber(extractSpan(xml, "q4")),
    cf1: toFiniteNumber(extractSpan(xml, "cf1")),
    cf4: toFiniteNumber(extractSpan(xml, "cf4")),
    cf6: toFiniteNumber(extractSpan(xml, "cf6")),
    cfx: toFiniteNumber(extractSpan(xml, "cfx")),
  };
}

export function parseMastershipXml(xml: string): { domains: string[] } {
  const blocks = extractListBlocks(xml, "msh-resource-li");
  const domains: string[] = [];
  for (const block of blocks) {
    const titleMatch = /title="([^"]+)"/i.exec(block);
    if (titleMatch?.[1]) {
      domains.push(decodeXmlEntities(titleMatch[1]));
    }
  }
  return { domains };
}
