import type { CardFieldValues } from "../db.ts";
import type { ThreadKind } from "../types.ts";
import type { GitHubClient } from "./app.ts";

/** The project field names a board reads per card (start/end date fields, estimate number field). */
export interface FieldNames {
  start?: string | null;
  end?: string | null;
  estimate?: string | null;
}

/** A GitHub Project (v2) and its status field, resolved once and cached. */
export interface ProjectInfo {
  id: string;
  title: string;
  url: string;
  fieldId: string;
  options: { id: string; name: string }[];
  /** Organization projects send webhooks; user projects only change when polled. */
  ownerType: "organization" | "user";
}

export interface ProjectItem {
  itemId: string;
  projectId: string;
  status: string | null;
  kind: ThreadKind | null;
  owner: string;
  repo: string;
  number: number;
  title: string;
  /** Values of the board's tracked fields, when it asked for them. */
  fields?: CardFieldValues;
}

const CONTENT = `
  content {
    __typename
    ... on Issue { number title repository { name owner { login } } }
    ... on PullRequest { number title repository { name owner { login } } }
  }`;

const STATUS = `fieldValueByName(name: $field) { ... on ProjectV2ItemFieldSingleSelectValue { name optionId } }`;

/** Extra variables and selections for the tracked fields' values. */
function tracked(names: FieldNames = {}): { vars: string; select: string; values: Record<string, string> } {
  const parts: { key: keyof FieldNames; type: "Date" | "Number" }[] = [
    { key: "start", type: "Date" },
    { key: "end", type: "Date" },
    { key: "estimate", type: "Number" },
  ];
  const used = parts.filter((part) => names[part.key]);
  return {
    vars: used.map((part) => `, $${part.key}Field: String!`).join(""),
    select: used.map((part) => `${part.key}: fieldValueByName(name: $${part.key}Field) { ... on ProjectV2ItemField${part.type}Value { ${part.type === "Date" ? "date" : "number"} } }`).join(" "),
    values: Object.fromEntries(used.map((part) => [`${part.key}Field`, names[part.key]!])),
  };
}

function toItem(node: any, projectId: string, names: FieldNames = {}): ProjectItem {
  const content = node?.content ?? {};
  const kind: ThreadKind | null = content.__typename === "Issue" ? "issue" : content.__typename === "PullRequest" ? "pull" : null;
  const fields: CardFieldValues = {};
  if (names.start) fields.start = node?.start?.date ? String(node.start.date).slice(0, 10) : null;
  if (names.end) fields.end = node?.end?.date ? String(node.end.date).slice(0, 10) : null;
  if (names.estimate) fields.estimate = typeof node?.estimate?.number === "number" ? node.estimate.number : null;
  return {
    ...(names.start || names.end || names.estimate ? { fields } : {}),
    itemId: node.id,
    projectId,
    status: node?.fieldValueByName?.name ?? null,
    kind,
    owner: content.repository?.owner?.login ?? "",
    repo: content.repository?.name ?? "",
    number: Number(content.number ?? 0),
    title: content.title ?? "",
  };
}

export async function resolveProject(gh: GitHubClient, owner: string, number: number, field: string): Promise<ProjectInfo> {
  const fragment = `projectV2(number: $number) {
    id title url
    field(name: $field) { ... on ProjectV2SingleSelectField { id name options { id name } } }
  }`;
  const data = await gh.graphql<any>(
    `query ResolveProject($owner: String!, $number: Int!, $field: String!) {
      organization(login: $owner) { ${fragment} }
    }`,
    { owner, number, field },
  ).catch(() => null);
  let project = data?.organization?.projectV2;
  const ownerType: ProjectInfo["ownerType"] = project ? "organization" : "user";
  if (!project) {
    const user = await gh.graphql<any>(`query ResolveUserProject($owner: String!, $number: Int!, $field: String!) { user(login: $owner) { ${fragment} } }`, { owner, number, field });
    project = user?.user?.projectV2;
  }
  if (!project) {
    throw new Error(
      `Project ${owner}/${number} not found, or it can't be read with these credentials. For an organization project, give the GitHub App the organization "Projects" permission (read and write) and accept the new permission on the installation. For a user-owned project, set token_env in the board file.`,
    );
  }
  if (!project.field?.id) throw new Error(`Project ${owner}/${number} has no single-select field called "${field}"`);
  return { id: project.id, title: project.title, url: project.url, fieldId: project.field.id, options: project.field.options, ownerType };
}

export async function getProjectItem(gh: GitHubClient, itemId: string, field: string, names?: FieldNames): Promise<ProjectItem | null> {
  const extra = tracked(names);
  const data = await gh.graphql<any>(
    `query BoardItem($id: ID!, $field: String!${extra.vars}) {
      node(id: $id) { ... on ProjectV2Item { id project { id } ${STATUS} ${extra.select} ${CONTENT} } }
    }`,
    { id: itemId, field, ...extra.values },
  );
  const node = data?.node;
  return node?.id ? toItem(node, node.project?.id ?? "", names) : null;
}

export async function listProjectItems(gh: GitHubClient, projectId: string, field: string, names?: FieldNames): Promise<ProjectItem[]> {
  const extra = tracked(names);
  const items: ProjectItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data: any = await gh.graphql(
      `query BoardItems($id: ID!, $field: String!, $after: String${extra.vars}) {
        node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id ${STATUS} ${extra.select} ${CONTENT} } } } }
      }`,
      { id: projectId, field, after, ...extra.values },
    );
    const connection = data?.node?.items;
    for (const node of connection?.nodes ?? []) items.push(toItem(node, projectId, names));
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return items;
}

/** Archives a card (it disappears from the board's views and from listings, and can be restored on GitHub). */
export async function archiveItem(gh: GitHubClient, projectId: string, itemId: string): Promise<void> {
  await gh.graphql(`mutation ArchiveBoardItem($project: ID!, $item: ID!) { archiveProjectV2Item(input: { projectId: $project, itemId: $item }) { item { id } } }`, { project: projectId, item: itemId });
}

export async function setItemStatus(gh: GitHubClient, project: ProjectInfo, itemId: string, column: string): Promise<void> {
  const option = project.options.find((candidate) => candidate.name.toLowerCase() === column.toLowerCase());
  if (!option) throw new Error(`The project has no "${column}" column (options: ${project.options.map((candidate) => candidate.name).join(", ")})`);
  await gh.graphql(
    `mutation MoveBoardItem($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
    }`,
    { project: project.id, item: itemId, field: project.fieldId, option: option.id },
  );
}

/** Adds an issue or pull request (by node id) to the project; returns its item id (the existing one if it's already there). */
export async function addProjectItem(gh: GitHubClient, project: ProjectInfo, contentId: string): Promise<string> {
  const data = await gh.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    `mutation AddBoardItem($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`,
    { project: project.id, content: contentId },
  );
  return data.addProjectV2ItemById.item.id;
}

/** A project field: its id, name and type (DATE, NUMBER, TEXT, SINGLE_SELECT, …). */
export interface ProjectField {
  id: string;
  name: string;
  dataType: string;
}

export async function listProjectFields(gh: GitHubClient, projectId: string): Promise<ProjectField[]> {
  const data = await gh.graphql<any>(
    `query BoardFields($id: ID!) {
      node(id: $id) { ... on ProjectV2 { fields(first: 100) { nodes { ... on ProjectV2FieldCommon { id name dataType } } } } }
    }`,
    { id: projectId },
  );
  return ((data?.node?.fields?.nodes ?? []) as any[]).filter((node) => node?.id).map((node) => ({ id: node.id, name: node.name, dataType: String(node.dataType) }));
}

/** Sets a date (YYYY-MM-DD) or number field on a project item; null clears it. */
export async function setItemField(gh: GitHubClient, projectId: string, itemId: string, fieldId: string, value: { date: string } | { number: number } | null): Promise<void> {
  if (value === null) {
    await gh.graphql(
      `mutation ClearBoardField($project: ID!, $item: ID!, $field: ID!) {
        clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) { projectV2Item { id } }
      }`,
      { project: projectId, item: itemId, field: fieldId },
    );
    return;
  }
  const [type, literal] = "date" in value ? ["Date", value.date] : ["Float", value.number];
  await gh.graphql(
    `mutation SetBoardField($project: ID!, $item: ID!, $field: ID!, $value: ${type}!) {
      updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { ${"date" in value ? "date" : "number"}: $value } }) { projectV2Item { id } }
    }`,
    { project: projectId, item: itemId, field: fieldId, value: literal },
  );
}
