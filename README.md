# Prose Polisher (Slop Analyzer)

SillyTavern extension that surfaces repetitive phrasing in AI replies and publishes the findings as a macro other extensions and prompts can reuse. The current refactor keeps everything on the client while staying responsive even on long chats.

## Highlights
- Manual chat analysis or opt-in automatic analysis of new AI messages with a configurable sampling window
- Pattern grouping merges similar phrases into templates with variant lists so families of "slop" are easy to spot
- Weighted scoring accounts for n-gram length, uncommon words, blacklist weights, and narration emphasis, then decays old scores over time
- Dynamic `{{slopList}}` macro returns JSON objects ready for prompts, scripts, or HTTP integrations
- Built-in frequency viewer, quick data reset, and dedicated whitelist/blacklist managers to fine-tune what gets flagged
- Exposes helper methods on `window.ProsePolisher` so final-response processors or other extensions can trigger refreshes on demand

## How It Works
1. **Preprocessing** – incoming AI messages are stripped of markup, split into sentences, and lemmatized with the bundled lemma map
2. **N-gram collection** – generates 3 to `Max N-gram Size` word chunks from narration and dialogue separately
3. **Scoring** – each chunk accumulates score from length, uncommon word count, blacklist weights, narration emphasis, and configurable score decay
4. **Pattern detection** – similar high scoring phrases are merged into shared prefixes with variant endings while standout singles are kept
5. **Macro output** – processed data is cached and emitted via the `{{slopList}}` macro as JSON, ready for prompts or other tooling

## Macro Output
`{{slopList}}` returns an array ordered by score, e.g.

```json
[
  {
    "pattern_template": "a flicker of {variant}",
    "variants": ["anger crossed his face", "doubt crossed her face"],
    "score": 12.5,
    "type": "pattern"
  },
  {
    "phrase": "her heart pounded in her chest",
    "score": 8.0,
    "type": "phrase"
  }
]
```

Pattern entries always contain `pattern_template` plus `variants`; individual phrases only use `phrase`. Consumers can JSON-parse the macro output directly.

## Settings
- Max N-gram Size (3–15) and Pattern Min Common Words (2–5) control phrase breadth and how aggressively patterns merge
- Slop Threshold (1.0–10.0) is the minimum score required before an item appears in results or the macro
- Score Decay Rate (%) and Decay Interval (messages) determine how quickly old phrases fade out of consideration
- Auto-analyze messages toggle keeps watching AI generations, running the heavy analysis every `Analysis Interval` messages
- Message Limit (-1 or a positive number) restricts manual and silent runs to the latest portion of the chat
- Whitelist and weighted Blacklist entries are editable via their managers; whitelist terms are ignored, blacklist weights (1–10) boost scores

Settings live under the extension drawer in SillyTavern and persist via `extension_settings`.

## UI Tools
- `Analyze Chat History` scans the current chat (respecting `Message Limit`), performs full analysis, and opens a leaderboard popup
- `View Frequency Data` shows the latest processed patterns or raw n-grams when processing has not run yet
- `Clear Frequency Data` wipes collected statistics, resets counters, and forces the macro back to `[]`
- `Whitelist Manager` and `Blacklist Manager` let you curate vocabulary without editing files by hand

## Integration
- Registers `slopList` with `MacrosParser` as a dynamic JSON macro that always reflects the latest analysis
- Adds `window.ProsePolisher.performSilentAnalysis()` so other extensions can refresh results before generation
- Provides `window.ProsePolisher.getSlopList()` for direct access to the current findings as structured data
- Offers `window.ProsePolisher.updateAnalysis()` to recompute and push fresh macro content when needed

## Files
- `manifest.json` – extension metadata for SillyTavern
- `content.js` – UI wiring, settings persistence, macro registration, and event listeners
- `analyzer.js` – scoring engine, pattern detection, whitelist/blacklist tooling, and analysis workflows
- Data files: `common_words.js`, `lemmas.js`, and `default_names.js` for filtering and lemmatization
- `styles.css` – drawer and popup styling used by the extension

## License

Same license as the original ProsePolisher extension.
