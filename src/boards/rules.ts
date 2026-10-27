/**
 * Optional, machine-checked rules for agent moves on a board: what an agent must show before it
 * moves a card into a column (evidence and handoff fields), and which columns a work type may
 * not enter. Boards without them behave as before. People moving cards are never checked.
 */

export const EVIDENCE = ["pull_request", "pushed", "tests", "review", "approval"] as const;
export type Evidence = (typeof EVIDENCE)[number];

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

/**
 * Reads and checks the rules in a board file. Used when a board loads (errors disable the board,
 * like any other board error) and when a board file is saved (errors reject the save).
 */
export function parseBoardRules(data: Record<string, unknown>): { columns: Record<string, ColumnRules>; workTypes: WorkType[]; errors: string[] } {
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
  return { columns, workTypes, errors };
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
