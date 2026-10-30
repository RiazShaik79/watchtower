// The shape a diagnosis must have (architecture §6). The model is held to DIAGNOSIS_SCHEMA by
// structured outputs, and validateDiagnosis() checks the result again before anything is stored
// (guardrail 2): exact fields only, sane lengths, and every piece of evidence must cite something
// that was actually supplied. Pure, so it's unit-tested.

export interface Diagnosis {
  summary: string;
  root_cause: string;
  evidence: { ref: string; why: string }[];
  confidence: number;
  blast_radius: string;
  immediate_mitigation: string;
  fix_approach: string;
  needs_human_only: boolean;
  missing_info: string[];
}

/** JSON schema sent as `output_config.format`. Limits the API can't express are checked below. */
export const DIAGNOSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "root_cause", "evidence", "confidence", "blast_radius", "immediate_mitigation", "fix_approach", "needs_human_only", "missing_info"],
  properties: {
    summary: { type: "string", description: "One or two sentences: what is failing, for whom." },
    root_cause: { type: "string", description: "The most likely cause, naming the file and function when the source shows it." },
    evidence: {
      type: "array",
      description: "Each item cites one supplied reference: event:<id>, file:<path>:<line>, or commit:<sha>.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "why"],
        properties: { ref: { type: "string" }, why: { type: "string" } },
      },
    },
    confidence: { type: "number", description: "0 to 1." },
    blast_radius: { type: "string", description: "Which users, routes or features are affected." },
    immediate_mitigation: { type: "string", description: "What a human could do right now, without a code change." },
    fix_approach: { type: "string", description: "How to fix it in code, in prose. No patches." },
    needs_human_only: { type: "boolean", description: "True if a fix would have to touch migrations, auth, .github, infra config or secrets." },
    missing_info: { type: "array", items: { type: "string" }, description: "What would raise confidence." },
  },
} as const;

const LIMITS = {
  summary: 600,
  root_cause: 2000,
  blast_radius: 600,
  immediate_mitigation: 1500,
  fix_approach: 2000,
  ref: 200,
  why: 500,
  missingItem: 300,
  evidenceMax: 12,
  missingMax: 10,
} as const;

/** What the model was shown, so its citations can be checked. */
export interface SuppliedRefs {
  events: Set<number>;
  /** Commit SHAs (any length ≥ 7); a citation matches by prefix. */
  commits: string[];
  /** Supplied file paths and their line counts. */
  files: Map<string, number>;
}

export type ValidationResult = { ok: true; value: Diagnosis } | { ok: false; errors: string[] };

const KEYS = DIAGNOSIS_SCHEMA.required as readonly string[];

function refProblem(ref: string, supplied: SuppliedRefs): string | null {
  const event = /^event:(\d+)$/.exec(ref);
  if (event) return supplied.events.has(Number(event[1])) ? null : `cites ${ref}, which wasn't supplied`;
  const commit = /^commit:([0-9a-f]{7,40})$/i.exec(ref);
  if (commit) {
    const sha = (commit[1] ?? "").toLowerCase();
    return supplied.commits.some((c) => c.toLowerCase().startsWith(sha) || sha.startsWith(c.toLowerCase())) ? null : `cites ${ref}, which wasn't supplied`;
  }
  const file = /^file:([^:\s]+?)(?::(\d+)(?:-(\d+))?)?$/.exec(ref);
  if (file) {
    const lines = supplied.files.get(file[1] ?? "");
    if (lines === undefined) return `cites ${ref}, a file that wasn't supplied`;
    const last = Number(file[3] ?? file[2] ?? 0);
    return last > lines ? `cites ${ref}, past the end of the file (${lines} lines)` : null;
  }
  return `evidence ref "${ref.slice(0, 60)}" isn't event:<id>, file:<path>:<line> or commit:<sha>`;
}

function text(value: unknown, field: string, max: number, errors: string[], allowEmpty = false): string {
  if (typeof value !== "string") {
    errors.push(`${field} must be a string`);
    return "";
  }
  if (!allowEmpty && !value.trim()) errors.push(`${field} is empty`);
  if (value.length > max) errors.push(`${field} is longer than ${max} characters`);
  return value;
}

/** Validate a parsed model answer. Unknown fields (e.g. an "action" a log line asked for) fail. */
export function validateDiagnosis(input: unknown, supplied: SuppliedRefs): ValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["the answer isn't a JSON object"] };
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(obj)) if (!KEYS.includes(key)) errors.push(`unexpected field "${key.slice(0, 40)}"`);
  for (const key of KEYS) if (!(key in obj)) errors.push(`missing field "${key}"`);

  const summary = text(obj.summary, "summary", LIMITS.summary, errors);
  const rootCause = text(obj.root_cause, "root_cause", LIMITS.root_cause, errors);
  const blastRadius = text(obj.blast_radius, "blast_radius", LIMITS.blast_radius, errors, true);
  const mitigation = text(obj.immediate_mitigation, "immediate_mitigation", LIMITS.immediate_mitigation, errors, true);
  const fixApproach = text(obj.fix_approach, "fix_approach", LIMITS.fix_approach, errors, true);

  const confidence = obj.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) errors.push("confidence must be a number from 0 to 1");
  if (typeof obj.needs_human_only !== "boolean") errors.push("needs_human_only must be true or false");

  const evidence: Diagnosis["evidence"] = [];
  if (!Array.isArray(obj.evidence)) errors.push("evidence must be a list");
  else {
    if (obj.evidence.length === 0) errors.push("evidence is empty");
    if (obj.evidence.length > LIMITS.evidenceMax) errors.push(`more than ${LIMITS.evidenceMax} evidence items`);
    for (const [i, item] of obj.evidence.slice(0, LIMITS.evidenceMax).entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`evidence[${i}] isn't an object`);
        continue;
      }
      const e = item as Record<string, unknown>;
      for (const key of Object.keys(e)) if (key !== "ref" && key !== "why") errors.push(`evidence[${i}] has unexpected field "${key.slice(0, 40)}"`);
      const ref = text(e.ref, `evidence[${i}].ref`, LIMITS.ref, errors);
      const why = text(e.why, `evidence[${i}].why`, LIMITS.why, errors);
      const problem = ref ? refProblem(ref, supplied) : null;
      if (problem) errors.push(`evidence[${i}] ${problem}`);
      evidence.push({ ref, why });
    }
  }

  const missing: string[] = [];
  if (!Array.isArray(obj.missing_info)) errors.push("missing_info must be a list");
  else {
    if (obj.missing_info.length > LIMITS.missingMax) errors.push(`more than ${LIMITS.missingMax} missing_info items`);
    for (const [i, item] of obj.missing_info.slice(0, LIMITS.missingMax).entries()) missing.push(text(item, `missing_info[${i}]`, LIMITS.missingItem, errors));
  }

  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  return {
    ok: true,
    value: {
      summary,
      root_cause: rootCause,
      evidence,
      confidence: confidence as number,
      blast_radius: blastRadius,
      immediate_mitigation: mitigation,
      fix_approach: fixApproach,
      needs_human_only: obj.needs_human_only as boolean,
      missing_info: missing,
    },
  };
}
