# Data contract

The page is static. It reads four JSON files from `data/` at load time (`fetch`, no cache) and never writes to them. To refresh the site, overwrite those files and nothing else. No build step is needed.

If a **required** field is wrong, items break or disappear. **Optional** fields are ignored when missing.

## Files

| File | Status | Used for |
| --- | --- | --- |
| `data/presentations.json` | **required**, JSON array | every item on the page |
| `data/people_index.json` | optional, JSON array | the "WashU PIs" section (without it that section is empty) |
| `data/sessions.json` | optional, JSON array | fallback session title, type, location, URL |
| `data/stats.json` | optional, JSON object | "Data last updated" in the footer (`generated`) |

## `presentations.json` (one object per item)

Required:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | unique; `people_index.json` refers to it |
| `title` | string | for chair, moderator, etc. a generic title ("Chair") is replaced with "Chair: <session title>" |
| `start`, `end` | string | ISO 8601 with offset, e.g. `2026-11-14T13:00:00-05:00`. Shown exactly as written (Eastern), never converted to the viewer's time zone |
| `date` | string | `YYYY-MM-DD`, drives day filter and grid columns |
| `url` | string | abstract link (`https://` only; anything else is dropped) |
| `session_url` | string | session link (`https://` only) |
| `don_link` | string | scope tier, see below |
| `format` | string | see below |
| `washu_authors` | array | `{ name, atlas_id, is_don_roster, dept_neuroscience }` per WashU author |

Optional (used when present): `presentation_number`, `activity`, `is_poster`, `room`, `posterboard`, `presenter`, `presenter_is_washu`, `authors` (`name`, `presenting`), `session` (`id`, `number`, `title`, `type`, `location`, `url`), `theme`, `keywords`, `abstract`.

### `don_link` (scope tiers)

| Value | Tier | Shown when |
| --- | --- | --- |
| `don` | DoN | always (default view) |
| `washu_neuro_directory`, `washu_probable` | WashU Neuroscience | scope is "WashU Neuroscience" or "All WashU" |
| `washu_other` | All WashU | scope is "All WashU" |
| `session_context` | Session context | only with the "Include session context" checkbox |

Any other value is treated as `washu_other`. To add a new tier, edit `TIER_BY_LINK` and `SCOPES` in `js/data.js`.

### `format`

- **WashU events** take priority over the other format types. An item is a WashU event if its `don_flags` contain `washu_named_session`, or if its session type is a satellite, ancillary or networking event whose title names WashU. These items appear in every scope and use the session title and description.
- `poster` (or `is_poster: true`) is a **Poster**.
- `chair`, `co chair`, `moderator`, `satellite organizer`, `award winner` are **Roles** (shown with a role label).
- Everything else, including `talk` and `lecture`, is a **Talk**.

### `theme`

A list of strings that start with a code such as `B.07.b. Network interactions`. The theme letter (`B`) is what the page filters on. Fragments produced by splitting on `;` are rejoined automatically. Items with no theme simply have no theme letter. Theme names are not in the data; to show them, fill in `THEME_NAMES` in `js/data.js` (for example `{ A: '...' }`).

## `people_index.json` (one object per roster person)

Required: `atlas_id`, `name`, `presentation_ids` (array of `presentations.json` ids).
Optional: `department`, `is_DoN` (boolean; puts the person in the "DoN faculty" group and in the "nothing found" list when they have no items), `lab_website` (`https://` only), `orcid`.

A person is also credited with any item where their `atlas_id` appears in `washu_authors`. Only people with at least one item are listed as presenting.

Faculty missing from the Atlas export can be seeded in `js/data.js` (`PERSON_SEEDS` and `AUTHOR_ALIASES`). Local ids use the `ATL-LOCAL-` prefix (for example Matt Gaidica → `ATL-LOCAL-000001` matched from `M. GAIDICA`).

## Things that must stay stable

- `id` values must be unique strings and must not change between runs for the same item.
- Times keep the `-05:00` style offset. A missing or malformed `start` sorts the item first and hides its time.
- Do not put HTML in text fields; everything is rendered as plain text. `abstract_html`, `title_html` and `author_block_html` are ignored.

## URL state

Filters live in the URL hash so views can be shared: `#scope=neuro&day=2026-11-16&fmt=poster&theme=E,I&q=dopamine&ctx=1`.
For testing, `#now=2026-11-16T14:00` makes the "What's next" section behave as if it were that Eastern time.
