import type { ThreadKind } from "../types.ts";
import type { GitHubClient } from "./app.ts";

/** A GitHub Project (v2) and its status field, resolved once and cached. */
export interface ProjectInfo {
  id: string;
  title: string;
  url: string;
  fieldId: string;
  options: { id: string; name: string }[];
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
}

const CONTENT = `
  content {
    __typename
    ... on Issue { number title repository { name owner { login } } }
    ... on PullRequest { number title repository { name owner { login } } }
  }`;

const STATUS = `fieldValueByName(name: $field) { ... on ProjectV2ItemFieldSingleSelectValue { name optionId } }`;

function toItem(node: any, projectId: string): ProjectItem {
  const content = node?.content ?? {};
  const kind: ThreadKind | null = content.__typename === "Issue" ? "issue" : content.__typename === "PullRequest" ? "pull" : null;
  return {
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
  if (!project) {
    const user = await gh.graphql<any>(`query ResolveUserProject($owner: String!, $number: Int!, $field: String!) { user(login: $owner) { ${fragment} } }`, { owner, number, field });
    project = user?.user?.projectV2;
  }
  if (!project) throw new Error(`Project ${owner}/${number} not found, or the GitHub App can't see it (it needs the Projects permission)`);
  if (!project.field?.id) throw new Error(`Project ${owner}/${number} has no single-select field called "${field}"`);
  return { id: project.id, title: project.title, url: project.url, fieldId: project.field.id, options: project.field.options };
}

export async function getProjectItem(gh: GitHubClient, itemId: string, field: string): Promise<ProjectItem | null> {
  const data = await gh.graphql<any>(
    `query BoardItem($id: ID!, $field: String!) {
      node(id: $id) { ... on ProjectV2Item { id project { id } ${STATUS} ${CONTENT} } }
    }`,
    { id: itemId, field },
  );
  const node = data?.node;
  return node?.id ? toItem(node, node.project?.id ?? "") : null;
}

export async function listProjectItems(gh: GitHubClient, projectId: string, field: string): Promise<ProjectItem[]> {
  const items: ProjectItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data: any = await gh.graphql(
      `query BoardItems($id: ID!, $field: String!, $after: String) {
        node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id ${STATUS} ${CONTENT} } } } }
      }`,
      { id: projectId, field, after },
    );
    const connection = data?.node?.items;
    for (const node of connection?.nodes ?? []) items.push(toItem(node, projectId));
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return items;
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
