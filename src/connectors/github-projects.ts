import { createHash } from 'node:crypto'
import { stringify } from 'yaml'
import { ghProjectSchema, type GhProjectConfig } from '../config.js'
import { scrub } from '../scrub.js'
import type { Connector, Cursor, Doc } from '../types.js'

export interface ProjectItem {
  id: string
  number?: string
  type: string
  content_id?: string
  updated_at: string
  title: string
  body: string
  status_raw?: string
  linked_issue?: string
  url: string
  assignees: string[]
  fields: Record<string, string>
  redacted: boolean
}
export interface ProjectSnapshot {
  id: string
  project: string
  title: string
  url: string
  field?: { id: string; name: string; options: { id: string; name: string }[] }
  items: ProjectItem[]
}
interface Page<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
interface FieldValue { name?: string; text?: string; date?: string; field?: { name: string } }
interface RawItem {
  id: string; fullDatabaseId?: string; type: string; updatedAt: string
  content?: { id: string; title: string; body: string; updatedAt?: string; number?: number; url?: string; repository?: { nameWithOwner: string }; assignees?: { nodes: { login: string }[] } }
  fieldValues: Page<FieldValue>
}
const VALUES = `nodes {
  ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
  ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
  ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { name } } }
} pageInfo { hasNextPage endCursor }`
const ITEM = `id fullDatabaseId type updatedAt
  content {
    ... on Issue { id number title body updatedAt url repository { nameWithOwner } assignees(first:100) { nodes { login } } }
    ... on PullRequest { id number title body updatedAt url repository { nameWithOwner } assignees(first:100) { nodes { login } } }
    ... on DraftIssue { id title body updatedAt assignees(first:100) { nodes { login } } }
  }
  fieldValues(first:100) { ${VALUES} }`

export const projectKey = (p: Pick<GhProjectConfig, 'owner' | 'number'>): string => `${p.owner}/${p.number}`
export const projectFile = (p: Pick<GhProjectConfig, 'owner' | 'number'>): string => `context/projects/github/${p.owner}-${p.number}.json`
export function projectConfigs(raw: Record<string, unknown> | undefined): GhProjectConfig[] {
  if (!raw || raw.disabled) return []
  return ((raw.projects ?? []) as unknown[]).map(p => ghProjectSchema.parse(p)).filter(p => !p.disabled)
}

/** Uses a direct host credential; repository-scoped aggregate proxies cannot query org projects. */
export class GithubProjectsClient {
  private token: string
  private endpoint: string
  constructor(readonly config: GhProjectConfig) {
    const ref = config.token ?? 'env:LORE_GITHUB_TOKEN'
    this.token = ref.startsWith('env:') ? process.env[ref.slice(4)] ?? '' : ref
    this.endpoint = config.api_base ?? 'https://api.github.com/graphql'
    if (!this.token && (config.token || !config.api_base)) throw new Error(`github_projects: missing ${ref} for ${projectKey(config)}`)
  }
  async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`github_projects: HTTP ${response.status} for ${projectKey(this.config)}`)
    const result = await response.json() as { data?: T; errors?: { message: string }[] }
    if (result.errors?.length || !result.data) {
      const message = (result.errors ?? []).map(e => e.message).join('; ') || 'empty GraphQL response'
      throw new Error(`github_projects: ${scrub(this.token ? message.split(this.token).join('[redacted]') : message).text}`)
    }
    return result.data
  }
  async read(): Promise<ProjectSnapshot> {
    // repositoryOwner resolves organizations AND users without masking auth errors
    // behind an organization→user retry. Items cannot be sorted by UPDATED_AT.
    const identity = await this.query<{ repositoryOwner: { projectV2?: { id: string; title: string; url: string; field: ProjectSnapshot['field'] } } | null }>(
      `query ProjectIdentity($owner:String!, $number:Int!, $field:String!) {
        repositoryOwner(login:$owner) {
          ... on Organization { projectV2(number:$number) { id title url field(name:$field) { ... on ProjectV2SingleSelectField { id name options { id name } } } } }
          ... on User { projectV2(number:$number) { id title url field(name:$field) { ... on ProjectV2SingleSelectField { id name options { id name } } } } }
        }
      }`, { owner: this.config.owner, number: this.config.number, field: this.config.status_field })
    const project = identity.repositoryOwner?.projectV2
    if (!project) throw new Error(`github_projects: project ${projectKey(this.config)} not found or inaccessible`)
    const items: ProjectItem[] = []
    let after: string | null = null
    const seenPages = new Set<string>()
    do {
      const data: { node: { items: Page<RawItem> } | null } = await this.query(
        `query ProjectItems($id:ID!, $after:String) { node(id:$id) { ... on ProjectV2 { items(first:100, after:$after, archivedStates:[ARCHIVED, NOT_ARCHIVED]) { nodes { ${ITEM} } pageInfo { hasNextPage endCursor } } } } }`,
        { id: project.id, after })
      if (!data.node) throw new Error('github_projects: project became inaccessible during pagination')
      const page = data.node.items
      for (const raw of page.nodes) {
        if (!raw) throw new Error('github_projects: missing item in project response')
        const values = [...raw.fieldValues.nodes]
        let fieldsAfter = nextPage(raw.fieldValues)
        const seenFields = new Set<string>()
        while (fieldsAfter) {
          if (seenFields.has(fieldsAfter)) throw new Error('github_projects: field pagination did not advance')
          seenFields.add(fieldsAfter)
          const more: { node: { fieldValues: Page<FieldValue> } } = await this.query(
            `query ProjectItemFields($id:ID!, $after:String) { node(id:$id) { ... on ProjectV2Item { fieldValues(first:100, after:$after) { ${VALUES} } } } }`, { id: raw.id, after: fieldsAfter })
          values.push(...more.node.fieldValues.nodes)
          fieldsAfter = nextPage(more.node.fieldValues)
        }
        const fields: Record<string, string> = {}
        for (const v of values) if (v?.field?.name) fields[v.field.name] = v.name ?? v.text ?? v.date ?? ''
        const c = raw.content
        items.push({ id: raw.id, number: raw.fullDatabaseId == null ? undefined : String(raw.fullDatabaseId), type: raw.type, content_id: c?.id,
          updated_at: [raw.updatedAt, c?.updatedAt ?? ''].sort().at(-1)!, title: c?.title ?? '', body: c?.body ?? '',
          status_raw: fields[this.config.status_field], fields,
          linked_issue: c?.repository && c.number ? `${c.repository.nameWithOwner}#${c.number}` : undefined,
          url: raw.fullDatabaseId ? `${project.url}?pane=issue&itemId=${raw.fullDatabaseId}` : project.url,
          assignees: c?.assignees?.nodes.map(a => a.login) ?? [], redacted: !c,
        })
      }
      after = nextPage(page)
      if (after && seenPages.has(after)) throw new Error('github_projects: pagination did not advance')
      if (after) seenPages.add(after)
    } while (after)
    return { ...project, project: projectKey(this.config), items }
  }
  statusOption(project: ProjectSnapshot, status: string): { field: string; option: string; column: string } {
    const column = Object.entries(this.config.status_map).find(([, s]) => s === status)?.[0]
    if (!column) throw new Error(`github_projects: status_map for ${project.project} has no column for lore status "${status}"`)
    const option = project.field?.options?.find(o => o.name === column)
    if (!project.field?.id || !option) throw new Error(`github_projects: ${project.project} has no single-select ${this.config.status_field} option "${column}"`)
    return { field: project.field.id, option: option.id, column }
  }
  async move(project: ProjectSnapshot, item: ProjectItem, status: string): Promise<void> {
    const option = this.statusOption(project, status)
    await this.query(`mutation MoveProjectItem($project:ID!, $item:ID!, $field:ID!, $option:String!) {
      updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}) { projectV2Item { id } }
    }`, { project: project.id, item: item.id, field: option.field, option: option.option })
    item.status_raw = option.column
    item.fields[this.config.status_field] = option.column
  }
  async edit(item: ProjectItem, fields: { title?: string; body?: string }): Promise<void> {
    if (!item.content_id || item.redacted) throw new Error(`github_projects: cannot edit inaccessible content ${item.id}`)
    const mutation = item.type === 'DRAFT_ISSUE' ? 'updateProjectV2DraftIssue' : item.type === 'ISSUE' ? 'updateIssue' : item.type === 'PULL_REQUEST' ? 'updatePullRequest' : undefined
    if (!mutation) throw new Error(`github_projects: unsupported item type ${item.type}`)
    const inputType = `${mutation[0].toUpperCase()}${mutation.slice(1)}Input`
    const idField = item.type === 'DRAFT_ISSUE' ? 'draftIssueId' : item.type === 'ISSUE' ? 'id' : 'pullRequestId'
    await this.query(`mutation EditProjectContent($input:${inputType}!) { ${mutation}(input:$input) { clientMutationId } }`, { input: { [idField]: item.content_id, ...fields } })
    Object.assign(item, fields)
  }
  async add(project: ProjectSnapshot, title: string, body: string, issue?: string): Promise<string> {
    if (issue) {
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(issue)
      if (!match) throw new Error(`github_projects: invalid issue ref ${issue}`)
      const data = await this.query<{ repository: { issueOrPullRequest: { id: string } | null } | null }>(
        `query ProjectContent($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner,name:$repo) { issueOrPullRequest(number:$number) { ... on Issue { id } ... on PullRequest { id } } } }`,
        { owner: match[1], repo: match[2], number: Number(match[3]) })
      const id = data.repository?.issueOrPullRequest?.id
      if (!id) throw new Error(`github_projects: issue ${issue} not found or inaccessible`)
      const added = await this.query<{ addProjectV2ItemById: { item: { id: string } } }>(
        `mutation AddProjectIssue($project:ID!, $content:ID!) { addProjectV2ItemById(input:{projectId:$project,contentId:$content}) { item { id } } }`, { project: project.id, content: id })
      return added.addProjectV2ItemById.item.id
    }
    const added = await this.query<{ addProjectV2DraftIssue: { projectItem: { id: string } } }>(
      `mutation AddProjectDraft($project:ID!, $title:String!, $body:String!) { addProjectV2DraftIssue(input:{projectId:$project,title:$title,body:$body}) { projectItem { id } } }`, { project: project.id, title, body })
    return added.addProjectV2DraftIssue.projectItem.id
  }
}
function nextPage<T>(page: Page<T>): string | null {
  if (!page.pageInfo.hasNextPage) return null
  if (!page.pageInfo.endCursor) throw new Error('github_projects: missing pagination cursor')
  return page.pageInfo.endCursor
}

export function projectDocs(project: ProjectSnapshot, old: Record<string, string> = {}): Doc[] {
  return project.items.filter(i => !i.redacted).flatMap(item => {
    // Include a fingerprint: linked-issue edits and option renames need not bump item.updatedAt.
    const fingerprint = createHash('sha256').update(JSON.stringify(item)).digest('hex')
    if (old[item.id] === fingerprint) return []
    return [{ id: `github-project-${item.id}`, source: 'github-projects', channel: project.project.replace('/', '-'),
      author: 'GitHub Projects', timestamp: new Date().toISOString(), permalink: item.url,
      meta: { item_node_id: item.id, project: project.project },
      text: `---\n${stringify({ project: project.project, item_node_id: item.id, number: item.number, title: item.title,
        status_raw: item.status_raw, assignees: item.assignees, linked_issue: item.linked_issue, url: item.url,
        updated_at: item.updated_at, fields: item.fields })}---\n${item.body}` }]
  })
}
export function projectCursor(project: ProjectSnapshot): Cursor {
  return { since: new Date().toISOString(), item_updated_ats: Object.fromEntries(project.items.map(i => [i.id, i.updated_at])),
    fingerprints: Object.fromEntries(project.items.map(i => [i.id, createHash('sha256').update(JSON.stringify(i)).digest('hex')])) }
}
export const githubProjects: Connector = {
  name: 'github_projects',
  async fetch(ctx) {
    const nextCursor = { ...ctx.cursor }
    const docs: Doc[] = []
    const files: Record<string, string> = {}
    const errors: string[] = []
    for (const cfg of projectConfigs(ctx.config)) {
      try {
        const project = await new GithubProjectsClient(cfg).read()
        const old = ctx.cursor[project.project] as { fingerprints?: Record<string, string> } | undefined
        docs.push(...projectDocs(project, old?.fingerprints))
        // Current snapshot for deterministic reconciliation, kept out of work-table readers.
        files[projectFile(cfg)] = scrub(JSON.stringify(project, null, 2)).text + '\n'
        nextCursor[project.project] = projectCursor(project)
        ctx.log(`${project.project}: ${project.items.length} items`)
      } catch (err) { errors.push(err instanceof Error ? err.message : String(err)) }
    }
    return { docs, files, nextCursor, errors }
  },
}
