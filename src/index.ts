interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * NIH RePORTER MCP — every NIH-funded research project (free, no auth)
 *
 * Covers ~$45B/yr of biomedical research grants: PI, institution, fiscal year,
 * award amount, abstract, mesh terms, congressional district. Pairs with
 * ClinicalTrials.gov for funding → trial → publication lineage.
 *
 * API: https://api.reporter.nih.gov/
 * Tools:
 * - search_grants:  filter by free text, PI, organization, fiscal year, state, IC
 * - get_project:    single full record by application ID
 * - search_publications: NIH-funded publications associated with grants
 */


const BASE_URL = 'https://api.reporter.nih.gov/v2';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_grants',
    description:
      'Search NIH-funded research projects. Filter by free-text query (matches title/abstract/terms), PI name, organization, fiscal year, US state, or NIH institute code (NCI, NHLBI, NIAID, etc.). Returns project number, PI, institution, fiscal year, award amount, and abstract preview.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search across title, abstract, terms' },
        pi_name: { type: 'string', description: 'PI last name (or any name part)' },
        organization: { type: 'string', description: 'Institution name (e.g., "Stanford University")' },
        fiscal_year: { type: 'number', description: 'Fiscal year (e.g., 2024)' },
        state: { type: 'string', description: 'US state code (e.g., "CA")' },
        ic: { type: 'string', description: 'NIH Institute/Center code (e.g., "NCI", "NHLBI", "NIMH")' },
        limit: { type: 'number', description: 'Results per page (1-500, default 25)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
      },
      required: [],
    },
  },
  {
    name: 'get_project',
    description:
      'Fetch a single NIH grant record by application ID (numeric, distinct from project number). Returns full project details including complete abstract, PIs, terms, sub-projects, and award history.',
    inputSchema: {
      type: 'object',
      properties: {
        appl_id: { type: 'number', description: 'NIH application ID (integer)' },
      },
      required: ['appl_id'],
    },
  },
  {
    name: 'search_publications',
    description:
      'Search publications acknowledging NIH funding. Filter by PMID, application ID, or core project number. Useful for "what came out of this grant" follow-ups.',
    inputSchema: {
      type: 'object',
      properties: {
        pmids: { type: 'string', description: 'Comma-separated PubMed IDs' },
        appl_ids: { type: 'string', description: 'Comma-separated NIH application IDs' },
        core_project_nums: { type: 'string', description: 'Comma-separated core project numbers (e.g., "R01CA123456")' },
        limit: { type: 'number', description: 'Results per page (1-500, default 25)' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: [],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_grants':
      return searchGrants(args);
    case 'get_project':
      return getProject(args.appl_id as number);
    case 'search_publications':
      return searchPublications(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function reporterPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NIH RePORTER error: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function searchGrants(args: Record<string, unknown>) {
  const criteria: Record<string, unknown> = {};
  if (args.query) {
    criteria.advanced_text_search = {
      operator: 'and',
      search_field: 'projecttitle,terms,abstracttext',
      search_text: String(args.query),
    };
  }
  if (args.pi_name) criteria.pi_names = [{ any_name: String(args.pi_name) }];
  if (args.organization) criteria.org_names = [String(args.organization)];
  if (args.fiscal_year) criteria.fiscal_years = [Number(args.fiscal_year)];
  if (args.state) criteria.org_states = [String(args.state).toUpperCase()];
  if (args.ic) criteria.agencies = [String(args.ic).toUpperCase()];

  const body = {
    criteria,
    include_fields: GRANT_FIELDS,
    offset: (args.offset as number) ?? 0,
    limit: Math.min(500, Math.max(1, (args.limit as number) ?? 25)),
    sort_field: 'project_start_date',
    sort_order: 'desc',
  };

  const data = await reporterPost<{ meta?: { total?: number }; results?: GrantRecord[] }>(
    '/projects/search',
    body,
  );

  return {
    total: data.meta?.total ?? 0,
    returned: data.results?.length ?? 0,
    grants: (data.results ?? []).map((r) => normalizeGrant(r)),
  };
}

async function getProject(applId: number) {
  const data = await reporterPost<{ results?: GrantRecord[] }>('/projects/search', {
    criteria: { appl_ids: [Number(applId)] },
    include_fields: GRANT_FIELDS_FULL,
    limit: 1,
  });
  const r = data.results?.[0];
  if (!r) throw new Error(`No NIH project for appl_id ${applId}`);
  return normalizeGrant(r, /* full = */ true);
}

async function searchPublications(args: Record<string, unknown>) {
  const criteria: Record<string, unknown> = {};
  if (args.pmids) criteria.pmids = String(args.pmids).split(',').map((s) => Number(s.trim())).filter(Boolean);
  if (args.appl_ids) criteria.appl_ids = String(args.appl_ids).split(',').map((s) => Number(s.trim())).filter(Boolean);
  if (args.core_project_nums) {
    criteria.core_project_nums = String(args.core_project_nums).split(',').map((s) => s.trim()).filter(Boolean);
  }

  const body = {
    criteria,
    offset: (args.offset as number) ?? 0,
    limit: Math.min(500, Math.max(1, (args.limit as number) ?? 25)),
  };

  const data = await reporterPost<{
    meta?: { total?: number };
    results?: { pmid?: number; coreproject?: string; applid?: number }[];
  }>('/publications/search', body);

  return {
    total: data.meta?.total ?? 0,
    returned: data.results?.length ?? 0,
    publications: (data.results ?? []).map((p) => ({
      pmid: p.pmid ?? null,
      pubmed_url: p.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/` : null,
      core_project_num: p.coreproject ?? null,
      appl_id: p.applid ?? null,
    })),
  };
}

// ── Field selection ───────────────────────────────────────────────────
const GRANT_FIELDS = [
  'ApplId',
  'ProjectNum',
  'CoreProjectNum',
  'ProjectTitle',
  'FiscalYear',
  'AwardAmount',
  'AwardNoticeDate',
  'ProjectStartDate',
  'ProjectEndDate',
  'AgencyIcAdmin',
  'ContactPiName',
  'PrincipalInvestigators',
  'Organization',
  'OrgState',
  'OrgCity',
  'OrgCountry',
  'PrefTerms',
];

const GRANT_FIELDS_FULL = [...GRANT_FIELDS, 'AbstractText', 'PhrText', 'Terms', 'SubprojectId'];

interface GrantRecord {
  appl_id?: number;
  project_num?: string;
  core_project_num?: string;
  project_title?: string;
  fiscal_year?: number;
  award_amount?: number;
  award_notice_date?: string;
  project_start_date?: string;
  project_end_date?: string;
  agency_ic_admin?: { code?: string; abbreviation?: string; name?: string };
  contact_pi_name?: string;
  principal_investigators?: { profile_id?: number; first_name?: string; last_name?: string }[];
  organization?: { org_name?: string; org_city?: string; org_state?: string; org_country?: string };
  pref_terms?: string;
  abstract_text?: string;
  phr_text?: string;
  terms?: string;
}

function normalizeGrant(r: GrantRecord, full = false) {
  const out: Record<string, unknown> = {
    appl_id: r.appl_id ?? null,
    project_num: r.project_num ?? null,
    core_project_num: r.core_project_num ?? null,
    title: r.project_title ?? null,
    fiscal_year: r.fiscal_year ?? null,
    award_amount: r.award_amount ?? null,
    award_notice_date: r.award_notice_date ?? null,
    project_start: r.project_start_date ?? null,
    project_end: r.project_end_date ?? null,
    nih_institute: r.agency_ic_admin?.abbreviation ?? r.agency_ic_admin?.code ?? null,
    nih_institute_name: r.agency_ic_admin?.name ?? null,
    contact_pi: r.contact_pi_name ?? null,
    pis: (r.principal_investigators ?? []).map((p) =>
      [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null,
    ),
    organization: r.organization?.org_name ?? null,
    org_city: r.organization?.org_city ?? null,
    org_state: r.organization?.org_state ?? null,
    org_country: r.organization?.org_country ?? null,
    terms_preview: r.pref_terms ?? null,
    reporter_url: r.appl_id ? `https://reporter.nih.gov/project-details/${r.appl_id}` : null,
  };
  if (full) {
    out.abstract = r.abstract_text ?? null;
    out.public_health_relevance = r.phr_text ?? null;
    out.terms = r.terms ?? null;
  }
  return out;
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
