# Ghost in the Ledger: shared spec (all helpers read this)

Entry for the DEV "Hacktoberfest Open-Source AI Challenge Week 4: Ghost in the Machine". Deadline Oct 31, 11:59 PM PDT.
Idea: paste your bank alert emails or a statement and a local open-weight model "haunts" you: ghosts of forgotten
subscriptions, vanishing month-end money, hidden bank fees, late-night spends. Private by default: runs offline with Ollama,
Groq (hosted open-weight model) is an optional fallback, a no-model offline template mode always works.

Rules for everyone
- Node 18+ only, ZERO npm dependencies (node:test, node:http, fetch). Plain HTML/CSS/JS in the browser, no CDNs, no external fonts.
- Work ONLY in the files you own (listed in your brief). Do not edit another helper's files.
- No em dashes anywhere in UI copy, docs or comments. Plain, friendly English. Sample data must be completely fake.
- Money: amounts are numbers in major units (dollars, not cents). Every item has an ISO currency code detected from symbols or codes. Different currencies are never added together: the dominant one is used, with a warning.

Item (output of ingest, input of ghosts)
  { date: "YYYY-MM-DD" | null, time: "HH:MM" | null, description: string, amount: number (always positive),
    direction: "debit" | "credit", currency: "USD" (any ISO code), balance: number | null, source: "csv" | "email" | "text" }

lib/ingest.js exports: parseInput(text: string, opts?: {filename?: string}) -> { items: Item[], warnings: string[] }
lib/ghosts.js  exports: analyze(items: Item[]) -> Finding[]  (pure, deterministic)
                        haunt(items: Item[], opts?) -> Promise<{ ghosts: Ghost[], backend, model, warnings }>
Finding = { id, kind, amount, evidence: Item[], facts: object }   kind in:
  "subscription" (same description and similar amount repeating about monthly or weekly), "fees" (bank charges, SMS, VAT, stamp duty, maintenance),
  "night" (debits between 00:00 and 04:59), "payday" (a credit followed by most of it gone within 3 days), "leak" (many small debits to the same place),
  "biggest" (largest single debit), "round" (suspiciously round transfers)
Ghost = { id, kind, title, story, amount, evidence: Item[] }

HTTP (server.js, port 8787, env PORT)
  GET  /api/status -> { backends: { ollama: { up: boolean, models: string[] }, groq: { configured: boolean } }, active: "ollama"|"groq"|"offline", model: string, pdf: boolean }
  POST /api/haunt  body { text: string, filename?: string } -> { ok: true, summary: { count, totalDebit, totalCredit, currency, from, to },
                     ghosts: Ghost[], backend: "ollama"|"groq"|"offline", model: string, warnings: string[] }   |  { ok: false, error: string }
  POST /api/extract-pdf  raw application/pdf body (max 15MB) -> { ok: true, text, pages, method: "pdftotext"|"basic" } | { ok: false, error }
  GET  /api/demo?set=us|uk|ng -> { text: string }   (default us; fake demo data from samples/)
  GET  /*          -> static files from public/
Env: GHOST_BACKEND=auto|ollama|groq|offline (default auto: ollama if up, else groq if GROQ_API_KEY, else offline), OLLAMA_URL (default http://127.0.0.1:11434),
     GHOST_TIMEOUT_MS (per story; default 60000 ollama, 15000 groq), GHOST_BUDGET_MS (all stories; default 150000),
     GHOST_MODEL (default llama3.2:3b for ollama, openai/gpt-oss-20b for groq), GROQ_API_KEY.

Safety rule for stories: the model may only use numbers and names given in the finding. After generation, every number in the story must appear
in the finding facts or evidence; if not, discard the story and use the deterministic template text. Never send the full raw statement to a model,
send only the finding facts and at most 6 evidence lines.
