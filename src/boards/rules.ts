/**
 * Optional, machine-checked rules for agent moves on a board: what an agent must show before it
 * moves a card into a column (evidence and handoff fields), and which columns a work type may
 * not enter. Boards without them behave as before. People moving cards are never checked.
 */

export const EVIDENCE = ["pull_request", "pushed", "tests", "review", "approval", "merged", "merged_into_parent", "sub_issues", "dependencies"] as const;
export type Evidence = (typeof EVIDENCE)[number];

/** Evidence the orchestrator can check for a card someone else works on (a parent moving its sub-issues). */
export const CARD_EVIDENCE: readonly Evidence[] = ["pull_request", "merged", "merged_into_parent", "sub_issues", "dependencies"];

export const HANDOFF_FIELDS = ["status", "decisions", "verified", "open_questions", "risks", "do_not_redo"] as const;
export type HandoffField = (typeof HANDOFF_FIELDS)[number];
export type HandoffFields = Partial<Record<HandoffField, string>>;

/** What each piece of evidence means, as the agent reads it. */
export const EVIDENCE_TEXT: Record<Evidence, string> = {
  pull_request: "an open pull request that has your latest commit",
  pushed: "commits you pushed in this task",
  tests: "a test run that passed after your last change",
  review: "your review verdict (approve or request changes) on the pull request",
  approval: "your approval of the pull request",
  merged: "your branch merged into the branch it targets (a sub-issue's parent branch, otherwise the default branch)",
  sub_issues: "every sub-issue's branch merged into this card's branch (or the sub-issue closed)",
  merged_into_parent: "for a sub-issue, its branch merged into the parent issue's branch (cards without a parent, and sub-issues with nothing to merge, pass)",
  dependencies: "every issue this card is blocked by is closed",
};

const FIELD_TITLES: Record<HandoffField, string> = {
  status: "Status",
  decisions: "Decisions",
  verified: "Verified",
  open_questions: "Open questions",
  risks: "Risks",
  do_not_redo: "Do not redo",
};

export const FIELD_HINTS: Record<HandoffField, string> = {
  status: "where the work stands",
  decisions: "what you decided, and why",
  verified: "what you checked, and how",
  open_questions: 'what is still unclear, or "none"',
  risks: 'what could go wrong, or "none"',
  do_not_redo: "what the next stage shouldn't repeat",
};

/** Commands that count as a test run when a column doesn't name its own. */
export const DEFAULT_TEST_COMMAND =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnode\s+(.*\s)?--test\b|\b(pytest|tox|nox|jest|vitest|mocha|rspec|phpunit|ctest)\b|\bpython\d?\s+-m\s+(pytest|unittest)\b|\b(go|cargo|dotnet|mix|swift|deno)\s+test\b|\b(mvn|mvnw|gradle|gradlew)\b.*\b(test|verify|check)\b|\bmake\s+(test|check)\b/;

export interface ColumnRules {
  /** Evidence an agent must have to move a card into the column. */
  evidence: Evidence[];
  /** Handoff fields an agent must fill to move a card into the column. */
  handoffRequired: HandoffField[];
  /** For `tests`: commands that count as a test run (substring match); empty = common test runners. */
  testCommands: string[];
}

export interface WorkType {
  name: string;
  /** Issue labels that mark a card as this type. */
  labels: string[];
  /** Columns agents may not move this type of card into. */
  forbid: string[];
}

export const NO_RULES: ColumnRules = { evidence: [], handoffRequired: [], testCommands: [] };

/** How a board treats sub-issues (the optional `sub_issues:` section). */
export interface SubIssueSettings {
  /** Column that sub-issues created by agents on this board land in; null = they aren't added to the board. */
  column: string | null;
  /** Columns an agent on a parent card may move the card's sub-issues to (needs-human is always allowed). */
  movesTo: string[];
}

export const NO_SUB_ISSUES: SubIssueSettings = { column: null, movesTo: [] };

/** The project fields a board tracks per card (the optional `fields:` section). */
export interface CardFieldSettings {
  /** Name of the project's date field for when work starts, e.g. "Start date". */
  start: string | null;
  /** Name of the project's date field for when work ends, e.g. "End date". */
  end: string | null;
  /** Name of the project's number field for the estimate, e.g. "Estimate". */
  estimate: string | null;
  /** Columns that set the start date (when it's empty) as a card enters them. */
  startOn: string[];
  /** Columns that set the end date as a card enters them. */
  endOn: string[];
}

export const NO_CARD_FIELDS: CardFieldSettings = { start: null, end: null, estimate: null, startOn: [], endOn: [] };

export function hasCardFields(settings: CardFieldSettings): boolean {
  return Boolean(settings.start || settings.end || settings.estimate);
}

export function hasRules(rules: ColumnRules): boolean {
  return rules.evidence.length > 0 || rules.handoffRequired.length > 0;
}

function list(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/** The board's needs-human column, as the loader reads it. */
export function needsHumanOf(data: Record<string, unknown>): string | null {
  return data.needs_human === undefined ? "Needs human" : data.needs_human ? String(data.needs_human) : null;
}

function parseColumnRules(raw: Record<string, unknown>, where: string, errors: string[]): ColumnRules {
  const evidence: Evidence[] = [];
  for (const item of list(raw.evidence)) {
    if ((EVIDENCE as readonly string[]).includes(item)) evidence.push(item as Evidence);
    else errors.push(`${where}.evidence: "${item}" isn't one of ${EVIDENCE.join(", ")}`);
  }
  const handoffRequired: HandoffField[] = [];
  for (const item of list(raw.handoff_required)) {
    if ((HANDOFF_FIELDS as readonly string[]).includes(item)) handoffRequired.push(item as HandoffField);
    else errors.push(`${where}.handoff_required: "${item}" isn't one of ${HANDOFF_FIELDS.join(", ")}`);
  }
  const testCommands = list(raw.test_command).map((command) => command.trim());
  if (testCommands.some((command) => !command)) errors.push(`${where}.test_command: give a command, e.g. "npm test"`);
  if (testCommands.length && !evidence.includes("tests")) errors.push(`${where}.test_command only applies with evidence: [tests]`);
  return { evidence: [...new Set(evidence)], handoffRequired: [...new Set(handoffRequired)], testCommands };
}

function parseWorkTypes(raw: unknown, columns: string[], needsHuman: string | null, errors: string[]): WorkType[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push('"work_types" must be a map of type name → { labels, forbid }');
    return [];
  }
  const types: WorkType[] = [];
  const owners = new Map<string, string>();
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const where = `work_types.${name}`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${where} must be a map with "labels" and "forbid"`);
      continue;
    }
    const entry = value as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (key !== "labels" && key !== "forbid") errors.push(`${where}: unknown setting "${key}" (use labels and forbid)`);
    const labels = list(entry.labels).map((label) => label.trim()).filter(Boolean);
    if (!labels.length) errors.push(`${where}: give it "labels" (the issue labels that mark a card as ${name})`);
    for (const label of labels) {
      const other = owners.get(label.toLowerCase());
      if (other) errors.push(`${where}: the label "${label}" is already used by work type ${other}`);
      else owners.set(label.toLowerCase(), name);
    }
    const forbid: string[] = [];
    for (const column of list(entry.forbid)) {
      if (needsHuman && column === needsHuman) errors.push(`${where}.forbid: agents can always move a card to "${needsHuman}"`);
      else if (!columns.includes(column)) errors.push(`${where}.forbid: "${column}" isn't listed under columns`);
      else forbid.push(column);
    }
    types.push({ name, labels, forbid });
  }
  return types;
}

function parseSubIssues(raw: unknown, columns: string[], needsHuman: string | null, errors: string[]): SubIssueSettings {
  if (raw === undefined || raw === null) return NO_SUB_ISSUES;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push('"sub_issues" must be a map with "column" and/or "moves_to"');
    return NO_SUB_ISSUES;
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) if (key !== "column" && key !== "moves_to") errors.push(`sub_issues: unknown setting "${key}" (use column and moves_to)`);
  let column: string | null = null;
  if (entry.column !== undefined && entry.column !== null) {
    const name = String(entry.column);
    if (!columns.includes(name)) errors.push(`sub_issues.column: "${name}" isn't listed under columns`);
    else column = name;
  }
  const movesTo: string[] = [];
  for (const name of list(entry.moves_to)) {
    if (!columns.includes(name) && name !== needsHuman) errors.push(`sub_issues.moves_to: "${name}" isn't listed under columns`);
    else if (!movesTo.includes(name)) movesTo.push(name);
  }
  return { column, movesTo };
}

const FIELD_KEYS = ["start", "end", "estimate", "start_on", "end_on"];

function parseCardFields(raw: unknown, columns: string[], needsHuman: string | null, errors: string[]): CardFieldSettings {
  if (raw === undefined || raw === null) return NO_CARD_FIELDS;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push('"fields" must be a map: start, end, estimate (project field names), start_on, end_on (columns)');
    return NO_CARD_FIELDS;
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) if (!FIELD_KEYS.includes(key)) errors.push(`fields: unknown setting "${key}" (use ${FIELD_KEYS.join(", ")})`);
  const name = (key: string): string | null => {
    const value = entry[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`fields.${key}: give the name of a field in the project, e.g. "${key === "estimate" ? "Estimate" : key === "start" ? "Start date" : "End date"}"`);
      return null;
    }
    return value.trim();
  };
  const settings: CardFieldSettings = { start: name("start"), end: name("end"), estimate: name("estimate"), startOn: [], endOn: [] };
  const names = [settings.start, settings.end, settings.estimate].filter(Boolean);
  if (new Set(names.map((value) => value!.toLowerCase())).size !== names.length) errors.push("fields: start, end and estimate must be different project fields");
  for (const [key, field, target] of [["start_on", "start", settings.startOn], ["end_on", "end", settings.endOn]] as const) {
    const listed = list(entry[key]);
    if (listed.length && !settings[field]) errors.push(`fields.${key} needs fields.${field} (the project's date field)`);
    for (const column of listed) {
      if (!columns.includes(column) && column !== needsHuman) errors.push(`fields.${key}: "${column}" isn't listed under columns`);
      else if (!target.includes(column)) target.push(column);
    }
  }
  return settings;
}

/**
 * Reads and checks the rules in a board file. Used when a board loads (errors disable the board,
 * like any other board error) and when a board file is saved (errors reject the save).
 */
export function parseBoardRules(data: Record<string, unknown>): {
  columns: Record<string, ColumnRules>;
  workTypes: WorkType[];
  subIssues: SubIssueSettings;
  fields: CardFieldSettings;
  errors: string[];
} {
  const errors: string[] = [];
  const rawColumns = (data.columns && typeof data.columns === "object" ? data.columns : {}) as Record<string, Record<string, unknown> | null>;
  const needsHuman = needsHumanOf(data);
  const columns: Record<string, ColumnRules> = {};
  for (const [name, raw] of Object.entries(rawColumns)) {
    columns[name] = parseColumnRules(raw ?? {}, name, errors);
    if (name === needsHuman && hasRules(columns[name]!)) {
      errors.push(`${name}: agents can always move a card to the needs-human column, so it can't require evidence or handoff fields`);
    }
  }
  const workTypes = parseWorkTypes(data.work_types, Object.keys(rawColumns), needsHuman, errors);
  const subIssues = parseSubIssues(data.sub_issues, Object.keys(rawColumns), needsHuman, errors);
  const fields = parseCardFields(data.fields, Object.keys(rawColumns), needsHuman, errors);
  return { columns, workTypes, subIssues, fields, errors };
}

/** The first work type (in file order) with one of the card's labels. */
export function workTypeFor(types: WorkType[], labels: string[]): { type: WorkType; label: string } | null {
  const lower = labels.map((label) => label.toLowerCase());
  for (const type of types) {
    const label = type.labels.find((candidate) => lower.includes(candidate.toLowerCase()));
    if (label) return { type, label };
  }
  return null;
}

export function forbids(type: WorkType | null | undefined, column: string): boolean {
  return Boolean(type?.forbid.some((name) => name.toLowerCase() === column.toLowerCase()));
}

export function missingFields(required: HandoffField[], fields: HandoffFields): HandoffField[] {
  return required.filter((field) => !fields[field]?.trim());
}

/** The handoff note as stored and shown to the next stage: the note, then the fields in a fixed order. */
export function renderHandoff(note: string, fields: HandoffFields): string {
  const sections = HANDOFF_FIELDS.filter((field) => fields[field]?.trim()).map((field) => {
    const value = fields[field]!.trim();
    return value.includes("\n") ? `**${FIELD_TITLES[field]}:**\n${value}` : `**${FIELD_TITLES[field]}:** ${value}`;
  });
  if (!sections.length) return note;
  return [note.trim(), ...sections].filter(Boolean).join("\n\n");
}

/** One line for the agent's prompt: what moving into a column takes. */
export function describeRules(rules: ColumnRules): string {
  const parts: string[] = [];
  if (rules.evidence.length) {
    const tests = rules.testCommands.length ? ` (a command containing ${rules.testCommands.map((command) => `\`${command}\``).join(" or ")})` : "";
    parts.push(rules.evidence.map((item) => (item === "tests" ? `${EVIDENCE_TEXT.tests}${tests}` : EVIDENCE_TEXT[item])).join("; "));
  }
  if (rules.handoffRequired.length) parts.push(`handoff fields: ${rules.handoffRequired.join(", ")}`);
  return parts.join("; ");
}

/** Does `command` count as a test run for a column? */
export function isTestCommand(rules: ColumnRules, command: string): boolean {
  return rules.testCommands.length ? rules.testCommands.some((candidate) => command.includes(candidate)) : DEFAULT_TEST_COMMAND.test(command);
}
