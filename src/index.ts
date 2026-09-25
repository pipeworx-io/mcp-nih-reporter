interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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
 * - nih_grant_award_history: annual award history for one core project
 * - nih_new_grant_awards: recent new competing awards
 * - nih_funding_concentration: award concentration across organizations, PIs, and mechanisms
 * - nih_sbir_company_portfolio: a company's NIH SBIR/STTR portfolio
 * - nih_funding_expirations: projects approaching their planned end date
 * - nih_grant_publication_summary: publication count and PMID sample for one core project
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'NIH Reporter');
}


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
      'Fetch one NIH project application record by application ID (numeric, distinct from project number). Returns its complete abstract, public-health relevance, terms, PIs, organization, dates, and award amount. Use nih_grant_award_history for multi-year award history.',
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
  {
    name: 'nih_grant_award_history',
    description:
      'Build the annual NIH award history for one core project number, including award, direct/indirect cost, budget dates, application type, and cumulative reported funding. Annual award amounts are obligations for each fiscal year—not company revenue, cash received, or guaranteed future funding.',
    inputSchema: {
      type: 'object',
      properties: {
        core_project_num: { type: 'string', description: 'Core project number, e.g. R43GM128494 or UG1HD078437.' },
      },
      required: ['core_project_num'],
    },
  },
  {
    name: 'nih_new_grant_awards',
    description:
      'Find recently issued NIH awards, optionally restricted to new competing applications, topic, organization, state, institute, activity code, or SBIR/STTR. Useful for financing and emerging-program monitoring; an award notice does not establish commercial validation or future funding.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Look-back window, 1–365 days (default 30).' },
        query: { type: 'string', description: 'Topic text across title, abstract, and terms.' },
        organization: { type: 'string' }, state: { type: 'string' }, ic: { type: 'string' },
        activity_code: { type: 'string', description: 'NIH activity code such as R01, R43, or U01.' },
        sbir_sttr_only: { type: 'boolean', description: 'Restrict to SBIR/STTR research projects.' },
        new_competing_only: { type: 'boolean', description: 'Restrict to application type 1 (default true).' },
        limit: { type: 'number', description: '1–100, default 25.' },
      },
      required: [],
    },
  },
  {
    name: 'nih_funding_concentration',
    description:
      'Summarize NIH award dollars and record counts by fiscal year, recipient organization, contact PI, activity code, and funding mechanism for a bounded topic, organization, or PI search. Results disclose truncation and represent reported federal obligations—not valuation, revenue, or total research spending.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' }, organization: { type: 'string' }, pi_name: { type: 'string' },
        from_fiscal_year: { type: 'number' }, to_fiscal_year: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'nih_sbir_company_portfolio',
    description:
      'Summarize an organization’s NIH SBIR/STTR award portfolio by core project, fiscal year, activity code, and PI. Organization matching is wildcard-based; verify recipient identity and note that reported award amounts are federal obligations, not revenue or unrestricted cash.',
    inputSchema: {
      type: 'object',
      properties: {
        organization: { type: 'string', description: 'Recipient organization name or distinctive fragment.' },
        from_fiscal_year: { type: 'number' }, to_fiscal_year: { type: 'number' },
      },
      required: ['organization'],
    },
  },
  {
    name: 'nih_funding_expirations',
    description:
      'Find active NIH projects matching a topic or organization whose current project period is scheduled to end soon. Treat the end date as a monitoring cue only—it can be extended, renewed, supplemented, or updated and does not prove a funding cliff.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' }, organization: { type: 'string' },
        days: { type: 'number', description: 'Forward window, 30–730 days (default 180).' },
        limit: { type: 'number', description: '1–100, default 25.' },
      },
      required: [],
    },
  },
  {
    name: 'nih_grant_publication_summary',
    description:
      'Count publications linked by NIH RePORTER to a core project number and return a bounded PMID sample. Publication linkage reflects acknowledged grant support; it is not a citation-impact, product-readiness, or causal-attribution measure.',
    inputSchema: {
      type: 'object',
      properties: {
        core_project_num: { type: 'string' }, limit: { type: 'number', description: 'PMID sample size, 1–100 (default 25).' },
      },
      required: ['core_project_num'],
    },
  },
];

function reqNum(args: Record<string, unknown>, key: string, example: string): number {
  const v = args[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) {
    throw new Error(`Required argument "${key}" is missing or invalid. Pass a number like ${example}.`);
  }
  return n;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_grants':
      return searchGrants(args);
    case 'get_project':
      return getProject(reqNum(args, 'appl_id', '10000001 (numeric appl_id from search results)'));
    case 'search_publications':
      return searchPublications(args);
    case 'nih_grant_award_history':
      return grantAwardHistory(args);
    case 'nih_new_grant_awards':
      return newGrantAwards(args);
    case 'nih_funding_concentration':
      return fundingConcentration(args);
    case 'nih_sbir_company_portfolio':
      return sbirCompanyPortfolio(args);
    case 'nih_funding_expirations':
      return fundingExpirations(args);
    case 'nih_grant_publication_summary':
      return grantPublicationSummary(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function reporterPost<T>(path: string, body: unknown): Promise<T> {
  const res = await pwFetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 10_000);
    throw new Error(`NIH RePORTER error: ${res.status} ${text.slice(0, 200)}`);
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > 8_000_000) throw new Error('NIH RePORTER response exceeded size limit');
  const text = await res.text();
  if (new TextEncoder().encode(text).length > 8_000_000) throw new Error('NIH RePORTER response exceeded size limit');
  return JSON.parse(text) as T;
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

type ProjectSearchResponse = { meta?: { total?: number; properties?: { URL?: string } }; results?: GrantRecord[] };

function requiredString(args: Record<string, unknown>, key: string) {
  const value = typeof args[key] === 'string' ? args[key].trim() : '';
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function boundedFiscalYears(args: Record<string, unknown>) {
  const current = new Date().getUTCFullYear() + 1;
  const from = args.from_fiscal_year == null ? current - 5 : Number(args.from_fiscal_year);
  const to = args.to_fiscal_year == null ? current : Number(args.to_fiscal_year);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1970 || to > current + 1 || from > to) {
    throw new Error('Fiscal-year range is invalid');
  }
  if (to - from > 15) throw new Error('Fiscal-year range may span at most 15 years');
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function textCriteria(args: Record<string, unknown>) {
  const criteria: Record<string, unknown> = { exclude_subprojects: true };
  if (args.query) criteria.advanced_text_search = {
    operator: 'and', search_field: 'projecttitle,terms,abstracttext', search_text: String(args.query),
  };
  if (args.organization) criteria.org_names = [String(args.organization)];
  if (args.pi_name) criteria.pi_names = [{ any_name: String(args.pi_name) }];
  return criteria;
}

async function projectSearch(criteria: Record<string, unknown>, options: { limit?: number; sortField?: string; sortOrder?: 'asc' | 'desc' } = {}) {
  return reporterPost<ProjectSearchResponse>('/projects/search', {
    criteria,
    include_fields: INTELLIGENCE_FIELDS,
    offset: 0,
    limit: Math.min(500, Math.max(1, options.limit ?? 500)),
    sort_field: options.sortField ?? 'award_notice_date',
    sort_order: options.sortOrder ?? 'desc',
  });
}

function coreProjectNumber(value: string) {
  const core = value.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z][A-Z0-9]{4,19}$/.test(core)) throw new Error('core_project_num must be a valid NIH core project number');
  return core;
}

function coreProjectPatterns(core: string) {
  return Array.from({ length: 9 }, (_, index) => `${index + 1}${core}*`);
}

function sumAwards(rows: GrantRecord[]) {
  return rows.reduce((sum, row) => sum + (typeof row.award_amount === 'number' ? row.award_amount : 0), 0);
}

function ranked(rows: GrantRecord[], key: (row: GrantRecord) => string | number | null | undefined) {
  const values = new Map<string, { records: number; reported_award_amount: number }>();
  for (const row of rows) {
    const label = String(key(row) ?? 'Unknown');
    const entry = values.get(label) ?? { records: 0, reported_award_amount: 0 };
    entry.records += 1;
    entry.reported_award_amount += typeof row.award_amount === 'number' ? row.award_amount : 0;
    values.set(label, entry);
  }
  return [...values.entries()].map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.reported_award_amount - a.reported_award_amount || b.records - a.records);
}

function coverage(data: ProjectSearchResponse, rows: GrantRecord[]) {
  const total = data.meta?.total ?? rows.length;
  return { matching_records: total, analyzed_records: rows.length, truncated: total > rows.length,
    reporter_url: data.meta?.properties?.URL ?? null };
}

async function grantAwardHistory(args: Record<string, unknown>) {
  const core = coreProjectNumber(requiredString(args, 'core_project_num'));
  const data = await projectSearch({ project_nums: coreProjectPatterns(core), exclude_subprojects: true },
    { sortField: 'fiscal_year', sortOrder: 'asc' });
  const rows = (data.results ?? []).filter((row) => row.core_project_num?.toUpperCase() === core);
  return {
    core_project_num: core, ...coverage(data, rows), cumulative_reported_award_amount: sumAwards(rows),
    awards: rows.map((row) => normalizeIntelligenceGrant(row)),
    scope_note: 'Award amounts are reported federal obligations for individual fiscal-year project records. Summing them is not a measure of company revenue, cash on hand, valuation, or guaranteed future support.',
  };
}

async function newGrantAwards(args: Record<string, unknown>) {
  const days = Math.min(365, Math.max(1, Number(args.days) || 30));
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const criteria = textCriteria(args);
  criteria.award_notice_date = { from_date: isoDate(from), to_date: isoDate(to) };
  if (args.new_competing_only !== false) criteria.award_types = ['1'];
  if (args.state) criteria.org_states = [String(args.state).toUpperCase()];
  if (args.ic) criteria.agencies = [String(args.ic).toUpperCase()];
  if (args.activity_code) criteria.activity_codes = [String(args.activity_code).toUpperCase()];
  if (args.sbir_sttr_only === true) criteria.funding_mechanism = ['SB'];
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
  const data = await projectSearch(criteria, { limit, sortField: 'award_notice_date', sortOrder: 'desc' });
  const rows = data.results ?? [];
  return { window: { from: isoDate(from), to: isoDate(to) }, new_competing_only: args.new_competing_only !== false,
    ...coverage(data, rows), awards: rows.map((row) => normalizeIntelligenceGrant(row)),
    scope_note: 'Award notices and application-type codes are monitoring inputs, not evidence of commercial validation, product approval, cash receipt timing, or future funding.' };
}

async function fundingConcentration(args: Record<string, unknown>) {
  if (!args.query && !args.organization && !args.pi_name) throw new Error('Provide query, organization, or pi_name to bound the analysis');
  const criteria = textCriteria(args);
  criteria.fiscal_years = boundedFiscalYears(args);
  const data = await projectSearch(criteria);
  const rows = data.results ?? [];
  return {
    fiscal_years: criteria.fiscal_years, ...coverage(data, rows), reported_award_amount: sumAwards(rows),
    by_fiscal_year: ranked(rows, (row) => row.fiscal_year),
    by_organization: ranked(rows, (row) => row.organization?.org_name).slice(0, 25),
    by_contact_pi: ranked(rows, (row) => row.contact_pi_name).slice(0, 25),
    by_activity_code: ranked(rows, (row) => row.project_num_split?.activity_code),
    by_funding_mechanism: ranked(rows, (row) => row.mechanism_code_dc ?? row.funding_mechanism),
    scope_note: 'Figures sum reported award_amount across returned fiscal-year project records. They are federal obligations, not revenue or total R&D spending; review truncated before using concentration shares.' };
}

async function sbirCompanyPortfolio(args: Record<string, unknown>) {
  const organization = requiredString(args, 'organization');
  const criteria: Record<string, unknown> = { org_names: [organization], funding_mechanism: ['SB'],
    fiscal_years: boundedFiscalYears(args), exclude_subprojects: true };
  const data = await projectSearch(criteria);
  const rows = data.results ?? [];
  const projects = new Map<string, GrantRecord[]>();
  for (const row of rows) {
    const key = row.core_project_num ?? row.project_num ?? `appl:${row.appl_id}`;
    projects.set(key, [...(projects.get(key) ?? []), row]);
  }
  return {
    organization_query: organization, fiscal_years: criteria.fiscal_years, ...coverage(data, rows),
    reported_award_amount: sumAwards(rows),
    portfolio: [...projects.entries()].map(([core, awards]) => ({ core_project_num: core,
      title: awards[0]?.project_title ?? null, organization: awards[0]?.organization?.org_name ?? null,
      activity_code: awards[0]?.project_num_split?.activity_code ?? null,
      contact_pi: awards[0]?.contact_pi_name ?? null, first_fiscal_year: Math.min(...awards.map((row) => row.fiscal_year ?? Infinity)),
      latest_fiscal_year: Math.max(...awards.map((row) => row.fiscal_year ?? -Infinity)),
      reported_award_amount: sumAwards(awards), award_records: awards.length,
    })).sort((a, b) => b.reported_award_amount - a.reported_award_amount),
    scope_note: 'NIH organization matching is wildcard-based; verify recipient identity. SBIR/STTR award amounts are federal obligations, not company revenue, unrestricted cash, valuation, or proof of technical success.' };
}

async function fundingExpirations(args: Record<string, unknown>) {
  if (!args.query && !args.organization) throw new Error('Provide query or organization to bound the search');
  const days = Math.min(730, Math.max(30, Number(args.days) || 180));
  const from = new Date();
  const to = new Date(from.getTime() + days * 86_400_000);
  const criteria = textCriteria(args);
  criteria.include_active_projects = true;
  criteria.project_end_date = { from_date: isoDate(from), to_date: isoDate(to) };
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
  const data = await projectSearch(criteria, { limit, sortField: 'project_end_date', sortOrder: 'asc' });
  const rows = data.results ?? [];
  return { window: { from: isoDate(from), to: isoDate(to) }, ...coverage(data, rows),
    projects: rows.map((row) => normalizeIntelligenceGrant(row)),
    scope_note: 'Project end dates are current NIH schedule fields and may be extended, renewed, supplemented, or revised. They identify review dates, not confirmed funding cliffs.' };
}

async function grantPublicationSummary(args: Record<string, unknown>) {
  const core = coreProjectNumber(requiredString(args, 'core_project_num'));
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
  const data = await reporterPost<{ meta?: { total?: number }; results?: { pmid?: number; coreproject?: string; applid?: number }[] }>(
    '/publications/search', { criteria: { core_project_nums: [core] }, offset: 0, limit });
  const publications = data.results ?? [];
  return { core_project_num: core, linked_publications: data.meta?.total ?? publications.length,
    returned: publications.length, truncated: (data.meta?.total ?? publications.length) > publications.length,
    publications: publications.map((row) => ({ pmid: row.pmid ?? null, latest_appl_id: row.applid ?? null,
      pubmed_url: row.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${row.pmid}/` : null })),
    scope_note: 'RePORTER publication links indicate acknowledged grant support. Counts are not citation impact, product readiness, or proof that one award caused an output.' };
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

const INTELLIGENCE_FIELDS = [...GRANT_FIELDS, 'BudgetStart', 'BudgetEnd', 'ProjectNumSplit', 'FundingMechanism',
  'MechanismCodeDc', 'DirectCostAmt', 'IndirectCostAmt', 'OpportunityNumber', 'IsActive'];

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
  subproject_id?: string | number;
  budget_start?: string;
  budget_end?: string;
  funding_mechanism?: string;
  mechanism_code_dc?: string;
  direct_cost_amt?: number;
  indirect_cost_amt?: number;
  opportunity_number?: string;
  is_active?: boolean;
  project_num_split?: { appl_type_code?: string; activity_code?: string; ic_code?: string; serial_num?: string; support_year?: string };
}

function normalizeDate(value?: string) {
  return value ? value.slice(0, 10) : null;
}

function normalizeIntelligenceGrant(r: GrantRecord) {
  return {
    appl_id: r.appl_id ?? null, project_num: r.project_num ?? null, core_project_num: r.core_project_num ?? null,
    title: r.project_title ?? null, fiscal_year: r.fiscal_year ?? null, award_amount: r.award_amount ?? null,
    direct_cost: r.direct_cost_amt ?? null, indirect_cost: r.indirect_cost_amt ?? null,
    award_notice_date: normalizeDate(r.award_notice_date), budget_start: normalizeDate(r.budget_start),
    budget_end: normalizeDate(r.budget_end), project_start: normalizeDate(r.project_start_date),
    project_end: normalizeDate(r.project_end_date), is_active: r.is_active ?? null,
    application_type: r.project_num_split?.appl_type_code ?? null, activity_code: r.project_num_split?.activity_code ?? null,
    funding_mechanism: r.funding_mechanism ?? null, funding_mechanism_code: r.mechanism_code_dc ?? null,
    opportunity_number: r.opportunity_number ?? null, organization: r.organization?.org_name ?? null,
    contact_pi: r.contact_pi_name ?? null,
    reporter_url: r.appl_id ? `https://reporter.nih.gov/project-details/${r.appl_id}` : null,
  };
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
    out.subproject_id = r.subproject_id ?? null;
  }
  return out;
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
