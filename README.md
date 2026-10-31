# Ghost in the Ledger

Paste your bank alert emails, SMS texts or a statement, from almost any bank in the world, and a friendly ghost shows you what is quietly haunting your money: forgotten subscriptions, small bank fees, late-night spends, a payday that vanished in three days.

Built for the DEV Hacktoberfest "Ghost in the Machine" challenge. It uses open-weight models (Gemma, Llama, gpt-oss) and has zero npm dependencies.

## Privacy story

Your money data is yours.

- The server only listens on `127.0.0.1`, so nothing outside your computer can open it.
- By default everything runs on your machine. If Ollama is installed, a small open-weight model writes the ghost stories locally.
- No Ollama? There is a built-in offline mode that writes the stories from templates. It needs no model and no internet.
- Groq (hosted open-weight model, default `openai/gpt-oss-20b`) is an optional fallback. It is only used if you set `GROQ_API_KEY`. Even then, the model never sees your whole statement. It only gets the facts of one finding plus at most 6 example lines.
- No analytics, no CDNs, no external fonts. The page loads nothing from the internet.

## Proof, not promises

Privacy claims are cheap, so the page shows its own numbers.

- **The ghost meter** is the slim bar at the top. The server wraps the one `fetch` it hands to every backend, so each outbound request is counted in a single place: outside calls, bytes sent out (URL, headers and body), local calls (Ollama on `127.0.0.1` or `localhost`, counted separately) and documents read. The totals are for this server session and are also in `GET /api/status` and every `/api/haunt` reply. With the offline backend the outside count stays at 0. If Groq is on, the real non-zero numbers are shown with a plain note, never a misleading zero.
- **What a cloud app would have uploaded** is a struck-through list after each run, built from that run's real transaction count, size in KB, distinct merchants and totals. Its last line says "Sent from here instead: nothing." or, if the meter shows outside calls, how many short fact summaries went to Groq.
- **Limits, stated plainly:** the meter counts the requests this server makes. It does not and cannot watch other programs on your computer or your network.
- **Save report (.md)** builds a markdown report in the browser with a provenance header (date, backend and model, and "processed locally" only when the outside count is 0). No network request is made.
- **Privacy scan** looks for card-like numbers, 10 digit account numbers, phone numbers, emails and long IDs before analysis. One button masks them in the textarea and keeps the last 4 digits. Amounts, dates and balances are never touched, so totals stay the same.

## Quick start

You need Node 18 or newer (Node 22 is what we test with). There is nothing to install.

```
git clone <this repo>
cd ghost-ledger
npm start
```

Open http://127.0.0.1:8787 and pick one of the three demo sets (US dollars, UK pounds or Nigerian naira) to try a fake statement, or paste your own.

Run the tests with:

```
npm test
```

## Using Ollama (private and local)

1. Install Ollama from https://ollama.com
2. Download a small model:

```
ollama pull llama3.2:3b
```

3. Make sure Ollama is running, then start the app with `npm start`.

The page shows which backend is active. If Ollama is up, it is used automatically. To use a different model, set `GHOST_MODEL`, for example `GHOST_MODEL=llama3.1:8b npm start`.

## Using Groq (optional)

1. Get a free API key at https://console.groq.com
2. Start the app with the key in your environment:

```
GROQ_API_KEY=your-key-here npm start
```

Groq is used when Ollama is not running. The default model is `openai/gpt-oss-20b` (open weights). If Groq retires a model you get a clear "not found" note, and you can set `GHOST_MODEL` to any model your account lists. Your key stays on the server and is never sent to the browser or shown in errors.

## Settings

| Variable | What it does | Default |
| --- | --- | --- |
| `PORT` | Port to listen on | `8787` |
| `GHOST_BACKEND` | `auto`, `ollama`, `groq` or `offline` | `auto` |
| `OLLAMA_URL` | Where Ollama lives | `http://127.0.0.1:11434` |
| `GHOST_MODEL` | Model name | `llama3.2:3b` (Ollama), `openai/gpt-oss-20b` (Groq) |
| `GROQ_API_KEY` | Turns on the Groq fallback | not set |
| `GHOST_TIMEOUT_MS` | Time allowed for each story from the model | `60000` (Ollama), `15000` (Groq) |
| `GHOST_BUDGET_MS` | Total time for all stories, then templates take over | `150000` |

With `auto`, the app uses Ollama if it is running, else Groq if a key is set, else offline mode.

## What you can paste

English-language text from banks and wallets anywhere (Chase, Bank of America, Wells Fargo, Barclays, Monzo, Revolut, Wise, PayPal, Cash App and many more, plus banks in Nigeria, Kenya, Ghana, South Africa and India):

- A CSV bank statement: `Date, Description, Amount, Balance`, or separate `Debit` and `Credit` (or `Money out` and `Money in`) columns, an optional `Currency` column, comma, semicolon or tab separated
- Pasted bank alert emails, or raw `.eml` text
- SMS and card notifications, for example "You made a $12.99 purchase at NETFLIX.COM", "Card ending 1234 was charged £4.50 at SPOTIFY", "Your account was debited €20,00" or "Debit alert: NGN 4,500.00 at Netflix on 05-Mar-2025 02:14"
- Plain lines like `2025-03-05 Netflix -45.00`

Currencies are found per item from symbols and codes: $ (USD), £, €, ₦ or N (NGN), ₹, ¥, KES, GHS, ZAR, CAD, AUD, JPY, or any three letter ISO code next to an amount. Amounts can use `1,234.56`, `1.234,56` or `20,00`, and `(12.99)` means money out. Amounts are money in major units (dollars, not cents).

Tested against fake alerts in the shapes used by GTBank, Access, Zenith, UBA, Opay, Kuda, Moniepoint, Sterling, FirstBank and ALAT. That covers one line SMS alerts, labelled multi line emails, HTML and quoted-printable emails, forwarded `>` quotes, alerts pasted back to back with no blank line, `29OCT26` style dates, `Time of Transaction` lines, a `Fee:` or `VAT:` line inside an alert (it becomes its own bank charge item), and statement CSVs with `Debits`/`Credits`, `Money In`/`Money Out` or `DR/CR` columns, title lines above the header and unquoted thousands commas. Banks change their wording often, so if a line is skipped you will see a warning that quotes it.

Amounts with no currency marker take a currency in this order: the main currency of the markers found elsewhere in the input; a default passed by the caller (`parseInput(text, { defaultCurrency: 'NGN' })`); NGN when the text names a Nigerian bank or uses Nigerian alert phrasing (GTBank, Opay, NIP, USSD, "Debit Alert"); otherwise USD, with a warning. An explicit marker such as `N`, `NGN` or the naira sign always wins.

Dates such as 03/05/2026 are read month first when the amounts are in USD and day first otherwise. If any date in the input has a day above 12, that settles it for the whole input.

If the input mixes currencies, they are never added together: the main currency is used and a warning tells you what was left out. If the app cannot find any transactions it tells you so instead of guessing.

## PDF statements

You can drop a bank statement PDF on the page. It is turned into text on your own computer with `pdftotext` (part of poppler), then read like any pasted statement. Fixed-width tables such as Ecobank, GTBank, Access, UBA and Zenith statements are understood: money in or out comes from the column the amount sits in (or from the balance going down or up), wrapped narration lines are joined, and page headers, footers, opening balance and totals are skipped.

Install poppler once:

```
sudo dnf install poppler-utils      # Fedora
sudo apt install poppler-utils      # Ubuntu or Debian
brew install poppler                # macOS
```

Without it, a small built-in reader still handles simple text PDFs (it is best effort, so install poppler for real bank files). Scanned PDFs (pictures of paper) have no text, so export a CSV or paste the text instead. Password protected PDFs must be unlocked first.

Privacy: the PDF is converted locally, held in memory only, never written to disk and never logged. Only the model, if you use one, sees a few short facts per ghost, never the statement.

## Slow laptop

Small models on a CPU can take a while per story. The app first loads the model with a tiny request (so load time is not counted against the first story), then writes the stories one at a time. Each story gets 60 seconds (15 for Groq) and all stories together get 150 seconds. After that, the remaining stories use offline templates and you see one warning. Partial results are kept.

- Raise the limits if your machine needs it: `GHOST_TIMEOUT_MS=180000 GHOST_BUDGET_MS=600000 npm start`
- Use a small model, for example `ollama pull gemma3:1b` and `GHOST_MODEL=gemma3:1b npm start`
- The page shows the model that really wrote the stories. If it says template, the model did not answer in time.

## What the ghosts are

| Ghost | What it spots |
| --- | --- |
| Subscription | The same place charging a similar amount about every month or week |
| Fees | Bank charges such as overdraft, monthly maintenance, ATM, foreign transaction, wire and NSF fees, SMS charges, VAT and stamp duty |
| Night | Debits between midnight and 4:59 AM |
| Payday | A big credit where most of it is gone within 3 days |
| Leak | Many small debits to the same place |
| Round | Suspiciously round transfers |
| Heaviest | Your single largest debit |

Finding ghosts is plain, deterministic code. Same input, same ghosts. The model only rewrites the story text.

## Which ghosts you see

At most 5. The five story themes (subscription, fees, payday, night, leak) come first, biggest amounts first, and the best subscription is always kept. Round numbers and the heaviest debit only fill slots the themes leave empty. If a model story fails the number guard, one warning says how many stories were replaced by templates.

## How the number guard works

Small models sometimes make up numbers. For a money app that is not okay, so every model story goes through a check:

1. The app computes the facts itself (counts, totals, dates).
2. The model gets only those facts and at most 6 example lines, and is told to use nothing else.
3. After it answers, every number in the story (including words like "seven") must appear in the facts or the example lines shown to it.
4. If even one number is not found, the story is thrown away and a template story built from the real facts is used instead. You will see a warning saying so.

The same fallback happens if the model is too slow (per story and total time limits, see Slow laptop), unreachable, or returns nothing. So the worst case is a plainer story, never a wrong number.

## Project layout

```
server.js        local HTTP server (static files plus the API)
lib/ingest.js    turns pasted text or CSV into transactions
lib/pdf.js       PDF to text (pdftotext, plus a basic built-in fallback)
lib/money.js     currency detection and formatting
lib/ghosts.js    finds the ghosts and checks the stories
lib/backends.js  Ollama, Groq and offline backends
public/          the web page
samples/         fake demo data (also pdf-layout-ecobank.txt and pdf-layout-generic.txt, text as pdftotext -layout makes it): demo-alerts-us.txt (USD), demo-statement-uk.csv (GBP), demo-alerts-ng.txt and demo-statement-ng.csv (NGN)
test/            node:test tests
```

API: `GET /api/status` (backends, `model`, and `pdf` true when pdftotext is installed), `POST /api/extract-pdf` (raw `application/pdf` body, up to 15MB, returns `{ ok, text, pages, method }`), `POST /api/haunt` with `{ "text": "...", "filename": "optional" }`, `GET /api/demo?set=us|uk|ng` (default `us`). Other request bodies are limited to 1MB.

Sample data is entirely fake. Please never commit real statements.

Made by TJS Code. MIT licensed.
