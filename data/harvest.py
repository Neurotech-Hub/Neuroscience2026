#!/usr/bin/env python3
"""
harvest.py - Build a dataset of WashU / Dept. of Neuroscience (DoN)-linked presentations
at SfN Neuroscience 2026 (abstractsonline meeting 21503).

Stages (each cached to raw/ so reruns are cheap):
  crawl    : list every session (session search "*"), fetch each Session + Session/{id}/Presentations,
             then cross-check against presentation search "*" and fetch any stragglers.
  names    : quoted presentation searches for every roster person (+ nickname / middle-initial variants)
             and last-name author-dataset searches for DoN faculty.
  affil    : affiliation phrase searches (diagnostic: how well the site's own search finds WashU work).
  build    : parse author blocks, match WashU affiliations + roster people, write outputs.

Usage:  python3 harvest.py [all|crawl|names|affil|build] [--delay 0.8] [--refresh-lists]
Python 3.9+, needs `requests`.
"""
import csv, hashlib, html, json, os, re, sys, time, unicodedata, argparse
from datetime import datetime
from zoneinfo import ZoneInfo
import requests

MEETING = "21503"
BASE = "https://www.abstractsonline.com/oe3"
PP8 = "https://www.abstractsonline.com/pp8/#!/" + MEETING
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
DON_CSV = "/workspace/atlas/exports/don_roster_20261112.csv"
WASHU_CSV = "/workspace/atlas/exports/washu_neuro_roster_20261112.csv"
TZ = ZoneInfo("America/New_York")
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36")
# Guest credential embedded in the public planner JS (pp8/js/app/util.js); same call every anonymous visitor makes.
GUEST = {"Username": "backpack", "Password": "89j34jks98cnjks989p;nfs44"}

AFFIL_PHRASES = [
    '"Washington University"', '"Washington Univ"', '"Washington Univ."',
    '"Washington University School of Medicine"', '"Washington Univ. Sch. of Med."',
    '"Washington University in St. Louis"', '"Washington Univ. in St. Louis"',
    '"Department of Neuroscience, Washington University"', '"Neurosci., Washington Univ"',
    'WashU', '"St. Louis, MO"', '"Saint Louis, MO"',
]

BACKOFF_CAP = 120   # seconds
MAX_DELAY = 5.0     # seconds between requests, upper bound
# ---------------------------------------------------------------- HTTP client
class Client:
    def __init__(self, delay=0.8):
        self.delay = delay
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Content-Type": "application/json",
                               "Accept": "application/json", "Caller": "PP8"})
        self.key = None
        self.last = 0.0
        self.errors = 0
        self.failed = []

    def _wait(self):
        dt = time.time() - self.last
        if dt < self.delay:
            time.sleep(self.delay - dt)
        self.last = time.time()

    def backpack(self, force=False):
        kf = os.path.join(RAW, "backpack.json")
        if not force and os.path.exists(kf):
            k = json.load(open(kf))
            if time.time() - k["t"] < 20 * 3600:
                self.key = k["ID"]
        if force or not self.key:
            self._wait()
            r = self.s.post(BASE + "/Backpack/create", json=GUEST, timeout=60)
            r.raise_for_status()
            self.key = json.loads(r.content.decode("utf-8-sig"))["ID"]
            json.dump({"ID": self.key, "t": time.time()}, open(kf, "w"))
        self.s.headers["Backpack"] = self.key

    def req(self, method, path, body=None, tries=6):
        if not self.key:
            self.backpack()
        for i in range(tries):
            self._wait()
            try:
                r = self.s.request(method, BASE + path, json=body, timeout=60)
                if r.status_code in (401, 403):
                    self.backpack(force=True); continue
                if r.status_code == 404:
                    return None
                r.raise_for_status()
                return json.loads(r.content.decode("utf-8-sig"))
            except Exception as e:
                # exponential backoff with a cap, and permanently slow down after trouble
                wait = min(BACKOFF_CAP, 5 * (2 ** i))
                self.delay = min(MAX_DELAY, self.delay * 1.5)
                self.errors += 1
                print(f"  ! {method} {path}: {e}; retry in {wait}s (delay now {self.delay:.1f}s)",
                      file=sys.stderr, flush=True)
                time.sleep(wait)
        self.failed.append(path)
        raise RuntimeError(f"giving up on {path}")

    def get(self, path):
        return self.req("GET", path)

    def search(self, dataset, phrase, pagesize=1000):
        s = self.req("POST", f"/Program/{MEETING}/Search/New/{dataset}", {"Phrase": phrase})
        n = 0
        while s.get("Status") != "Complete" and n < 60:
            time.sleep(1); n += 1
            s = self.get(f"/Program/{MEETING}/Search/{s['SearchId']}")
        out, page = [], 1
        if str(s.get("Count")) not in ("0", ""):
            while True:
                j = self.get(f"/Program/{MEETING}/Search/{s['SearchId']}/Results"
                             f"?page={page}&pagesize={pagesize}&sort=1&order=asc")
                res = (j or {}).get("Results") or []
                out += res
                if len(res) < pagesize:
                    break
                page += 1
        return {"search": s, "results": out, "fetched": time.time()}

# ---------------------------------------------------------------- cache helpers
def cpath(*parts):
    p = os.path.join(RAW, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p

def cached(path, fn, refresh=False):
    if os.path.exists(path) and not refresh:
        return json.load(open(path, encoding="utf-8"))
    data = fn()
    tmp = path + ".tmp"
    json.dump(data, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    os.replace(tmp, path)
    return data

def search_cached(cl, dataset, phrase, refresh=False):
    h = hashlib.sha1(phrase.encode()).hexdigest()[:16]
    return cached(cpath("search", dataset, h + ".json"),
                  lambda: cl.search(dataset, phrase), refresh)

# ---------------------------------------------------------------- stage: crawl
def stage_crawl(cl, refresh_lists=False):
    sl = search_cached(cl, "session", "*", refresh_lists)
    sids = [r["Id"] for r in sl["results"]]
    print(f"[crawl] {len(sids)} sessions (search count {sl['search'].get('Count')})")
    seen = set()
    failed = []
    for i, sid in enumerate(sids, 1):
        try:
            cached(cpath("session", f"{sid}.json"), lambda: cl.get(f"/Program/{MEETING}/Session/{sid}"))
            pres = cached(cpath("session_pres", f"{sid}.json"),
                          lambda: cl.get(f"/Program/{MEETING}/Session/{sid}/Presentations") or [])
            seen.update(p["Id"] for p in pres)
        except RuntimeError as e:
            failed.append(sid); print(f"[crawl] FAILED session {sid}: {e}", flush=True)
        if i % 50 == 0:
            print(f"[crawl] {i}/{len(sids)} sessions, {len(seen)} presentations", flush=True)
    pl = search_cached(cl, "presentation", "*", refresh_lists)
    allp = [r["Id"] for r in pl["results"]]
    missing = [p for p in allp if p not in seen]
    print(f"[crawl] presentation search '*' = {len(allp)}; covered by sessions {len(seen)}; "
          f"stragglers {len(missing)}")
    for pid in missing:
      try:
        p = cached(cpath("presentation", f"{pid}.json"),
                   lambda: cl.get(f"/Program/{MEETING}/Presentation/{pid}"))
        if p and p.get("SessionId") and not os.path.exists(cpath("session", f"{p['SessionId']}.json")):
            cached(cpath("session", f"{p['SessionId']}.json"),
                   lambda: cl.get(f"/Program/{MEETING}/Session/{p['SessionId']}"))
      except RuntimeError as e:
        failed.append("presentation:" + pid)
    cov = {"sessions_listed": len(sids),
           "sessions_fetched": sum(os.path.exists(cpath("session_pres", f"{x}.json")) for x in sids),
           "failed": failed, "presentations_listed": len(allp), "presentations_from_sessions": len(seen),
           "stragglers": len(missing), "http_errors": cl.errors,
           "finished": datetime.now(TZ).isoformat(timespec="seconds")}
    json.dump(cov, open(os.path.join(RAW, "crawl_coverage.json"), "w"), indent=1)
    print("[crawl] coverage", cov, flush=True)

# ---------------------------------------------------------------- names
NICK = {  # formal -> common short forms (both directions applied)
 "matthew": ["matt"], "robert": ["rob", "bob", "bobby"], "william": ["will", "bill", "billy"],
 "elizabeth": ["liz", "beth", "betsy", "lisa"], "michael": ["mike"], "christopher": ["chris"],
 "christine": ["chris", "christy"], "christina": ["chris", "tina"], "james": ["jim", "jamie"],
 "thomas": ["tom"], "joseph": ["joe"], "daniel": ["dan", "danny"], "david": ["dave"],
 "richard": ["rick", "rich", "dick"], "steven": ["steve"], "stephen": ["steve"],
 "andrew": ["andy", "drew"], "anthony": ["tony"], "edward": ["ed", "ted"], "benjamin": ["ben"],
 "jonathan": ["jon"], "john": ["jack"], "nicholas": ["nick"], "timothy": ["tim"],
 "lawrence": ["larry"], "gregory": ["greg"], "jeffrey": ["jeff"], "joshua": ["josh"],
 "samuel": ["sam"], "alexander": ["alex"], "alexandra": ["alex"], "katherine": ["kate", "kathy", "katie"],
 "catherine": ["cathy", "kate"], "kathryn": ["kate", "katie"], "jennifer": ["jen", "jenny"],
 "rebecca": ["becky"], "patricia": ["pat", "trish"], "patrick": ["pat"], "margaret": ["meg", "peggy"],
 "susan": ["sue"], "suzanne": ["sue"], "deborah": ["deb", "debbie"], "victoria": ["vicky", "tori"],
 "kenneth": ["ken"], "ronald": ["ron"], "donald": ["don"], "douglas": ["doug"], "charles": ["charlie", "chuck"],
 "frederick": ["fred"], "gerald": ["jerry"], "harold": ["harry"], "henry": ["hank"], "jacob": ["jake"],
 "leonard": ["len"], "nathaniel": ["nate", "nathan"], "nathan": ["nate"], "peter": ["pete"],
 "philip": ["phil"], "phillip": ["phil"], "raymond": ["ray"], "theodore": ["ted"], "vincent": ["vince"],
 "zachary": ["zach"], "abigail": ["abby"], "allison": ["allie"], "barbara": ["barb"], "cynthia": ["cindy"],
 "dorothy": ["dot"], "jessica": ["jess"], "judith": ["judy"], "kimberly": ["kim"], "pamela": ["pam"],
 "samantha": ["sam"], "stephanie": ["steph"], "teresa": ["terry"], "theresa": ["terry"], "valerie": ["val"],
 "ashley": ["ash"], "gabriel": ["gabe"], "gabrielle": ["gabby"], "eugene": ["gene"], "francis": ["frank"],
 "franklin": ["frank"], "frances": ["fran"], "jacqueline": ["jackie"], "madeline": ["maddie"],
 "michelle": ["shelly"], "nicole": ["nikki"], "rachel": ["rachael"], "ricardo": ["rick"], "roberto": ["rob"],
 "alberto": ["al"], "albert": ["al"], "alfred": ["al"], "arthur": ["art"], "bradley": ["brad"],
 "cameron": ["cam"], "carolyn": ["carol"], "caroline": ["carrie"], "dennis": ["denny"], "eric": ["erik"],
 "erik": ["eric"], "jeremy": ["jerry"], "louis": ["lou"], "marcus": ["marc"], "mitchell": ["mitch"],
 "randall": ["randy"], "russell": ["russ"], "sebastian": ["seb"], "terrence": ["terry"], "walter": ["walt"],
 "kristen": ["kristin", "kris"], "kristin": ["kristen"], "camillo": ["camillo"], "tristan": [],
}
PARTICLES = {"van", "von", "de", "del", "della", "der", "den", "da", "di", "du", "la", "le", "st", "st.", "ter", "ten", "dos", "das"}

def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.replace("’", "'")
    return re.sub(r"[^a-z]", "", s.lower())

def fix_name(first, middle, last):
    """Atlas splits 'David Van Essen' as middle=Van last=Essen; move particles back into last."""
    if middle and middle.split()[-1].lower().strip(".") in PARTICLES:
        return first, "", f"{middle} {last}"
    return first, middle, last

def first_variants(first):
    f = first.strip()
    out = {f}
    k = f.lower()
    for s in NICK.get(k, []):
        out.add(s.capitalize())
    for formal, shorts in NICK.items():
        if k in shorts:
            out.add(formal.capitalize())
    return sorted(out)

def load_roster():
    people = {}
    for fn, src in ((WASHU_CSV, "washu"), (DON_CSV, "don")):
        for r in csv.DictReader(open(fn, encoding="utf-8")):
            p = people.setdefault(r["atlas_id"], dict(r))
            p.update({k: v for k, v in r.items() if v})
            p["is_DoN"] = (p.get("is_DoN") == "yes") or src == "don"
    for p in people.values():
        p["first"], p["middle"], p["last"] = fix_name(p["first"].strip(), p["middle"].strip(), p["last"].strip())
        p["display_name"] = " ".join(x for x in (p["first"], p["middle"], p["last"]) if x)
        qs = []
        for fv in first_variants(p["first"]):
            qs.append(f"{fv} {p['last']}")
            if p["middle"]:
                mi = p["middle"][0]
                qs += [f"{fv} {mi} {p['last']}", f"{fv} {mi}. {p['last']}", f"{fv} {p['middle']} {p['last']}"]
        p["queries"] = list(dict.fromkeys('"%s"' % q for q in qs))
    return people

def stage_names(cl, people):
    todo = [(p, q) for p in people.values() for q in p["queries"]]
    print(f"[names] {len(todo)} quoted presentation searches for {len(people)} people")
    for i, (p, q) in enumerate(todo, 1):
        try:
            search_cached(cl, "presentation", q)
        except RuntimeError:
            print(f"[names] FAILED {q}", flush=True)
        if i % 100 == 0:
            print(f"[names] {i}/{len(todo)}")
    don = [p for p in people.values() if p["is_DoN"]]
    for p in don:  # author dataset (accepts last names)
        for q in (p["last"], f'"{p["first"]} {p["last"]}"'):
            try:
                search_cached(cl, "author", q)
            except RuntimeError:
                print(f"[names] FAILED author {q}", flush=True)

def stage_affil(cl):
    for q in AFFIL_PHRASES:
        r = search_cached(cl, "presentation", q)
        print(f"[affil] {q}: {r['search'].get('Count')}")

# ---------------------------------------------------------------- parsing
def strip_html(s):
    s = re.sub(r"<br\s*/?>", "\n", s or "", flags=re.I)
    s = re.sub(r"</p\s*>", "\n\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s).replace("\xa0", " ")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n\s*\n\s*\n+", "\n\n", s)
    return s.strip()

WASHU_RE = re.compile(r"(?<!George )(?<!Central )(?<!Eastern )(?<!Western )(?<!of )\bWashington\s+Univ(ersity|\.)?(?!\s+of\s+(Seattle|Washington))|\bWash\s?U\b|\bWUSTL\b|\bWUSM\b", re.I)
NEURO_DEPT_RE = re.compile(r"^\s*(the\s+)?(Dept\.?\s+of\s+|Department\s+of\s+)?Neurosci(ence|\.)?(\s+Dept\.?)?\s*$", re.I)

INST_RE = re.compile(r"Univ|Inst|Coll|Sch\.|School|Hosp|Ctr\.?$|Center|Centre|Fndn|Foundation|Inc\b|NIH|Corp|Ltd|Acad|Clinic|Lab\.?$|Laboratories|VA\b|Program|Consortium|\bWashU", re.I)
PROBABLE_RE = re.compile(r"(Saint|St\.?)\s*Louis,\s*MO", re.I)

def is_washu_probable(text):
    """St. Louis, MO affiliation with no institution named (author left it blank); very likely WashU."""
    if not text or is_washu(text) or not PROBABLE_RE.search(text):
        return False
    head = PROBABLE_RE.split(text)[0]
    return not INST_RE.search(head) and not re.search(r"Saint Louis Univ|St\.? Louis Univ|Bruker|Burroughs|Adaptive|California", text, re.I)

def is_washu(text):
    return bool(WASHU_RE.search(text or ""))

def parse_author_block(block):
    """Return (authors, affiliations).  authors: [{raw, name, initials, last, presenting, aff_ids}],
    affiliations: {id: {"text": full, "dept": first-part, "group_text": raw group}}"""
    if not block:
        return [], {}
    b = html.unescape(block).replace("\xa0", " ")
    m = re.search(r";\s*<br\s*/?>", b, re.I)
    if m:
        a_part, f_part = b[:m.start()], b[m.end():]
    elif re.search(r"<br\s*/?>", b, re.I):
        parts = re.split(r"<br\s*/?>", b, maxsplit=1, flags=re.I)
        a_part, f_part = parts[0], parts[1]
    elif "<sup" not in b.lower() and "," in b:
        # e.g. satellite events: "Rashelle Popinski, Saint Louis, MO" (single name + place)
        a_part, f_part = b.split(",", 1)
    else:
        a_part, f_part = b, ""
    # authors
    a = re.sub(r"<sup>\s*([^<]*?)\s*</sup>", lambda mm: "{" + mm.group(1) + "}", a_part, flags=re.I)
    a = re.sub(r"</?(b|i|strong|em|span)[^>]*>", "", a, flags=re.I)
    chunks = [c.strip() for c in re.split(r",\s*(?![^{]*\})", a) if c.strip()]
    # rejoin suffixes like ", JR." / ", III"
    merged = []
    for c in chunks:
        if merged and re.fullmatch(r"(JR|SR|II|III|IV|Esq|PhD|MD|MD,? PhD|DVM)\.?(\{.*\})?", c, re.I):
            merged[-1] += ", " + c
        else:
            merged.append(c)
    authors = []
    for c in merged:
        ids = [x for x in re.findall(r"\{([^}]*)\}", c)]
        ids = [y.strip() for x in ids for y in x.split(",") if y.strip()]
        name = re.sub(r"\{[^}]*\}", "", c).strip()
        presenting = name.startswith("*")
        name = name.lstrip("*").strip()
        toks = name.split()
        ini = []
        while len(toks) > 1 and re.fullmatch(r"([A-Za-z]\.)(-?[A-Za-z]\.)*|[A-Z]\.?-[A-Z]\.?", toks[0]):
            ini.append(toks.pop(0))
        given = ""
        if not ini and len(toks) > 1:          # full-name style "Linda Richards"
            given = toks.pop(0)
            ini = [given[0] + "."]
        last = " ".join(toks)
        authors.append({"raw": c, "name": name, "initials": " ".join(ini), "given": given, "last": last,
                        "presenting": presenting, "aff_ids": ids})
    # affiliations
    f = re.sub(r"</?(b|i|strong|em|span)[^>]*>", "", f_part, flags=re.I)
    f = re.sub(r"<br\s*/?>", " ", f, flags=re.I)
    affs = {}
    if "<sup>" not in f.lower():
        txt = strip_html(f).strip(" ;.")
        if txt:
            affs["1"] = {"text": txt, "dept": txt.split(",")[0].strip(), "group_text": txt}
        for au in authors:
            if not au["aff_ids"] and txt:
                au["aff_ids"] = ["1"]
        return authors, affs
    groups = [g.strip() for g in re.split(r";\s*(?=<sup>)", f) if g.strip()]
    for g in groups:
        segs = re.findall(r"<sup>\s*([^<]*?)\s*</sup>\s*(.*?)(?=<sup>|$)", g, re.I | re.S)
        segs = [(i.strip(" ,"), strip_html(t).strip(" ,;")) for i, t in segs]
        if not segs:
            continue
        last_txt = segs[-1][1]
        lparts = [x.strip() for x in last_txt.split(",")]
        if len(segs) > 1 and INST_RE.search(lparts[0]):
            suffix = last_txt            # last segment is the institution itself
        else:
            suffix = ", ".join(lparts[1:]) if len(segs) > 1 and len(lparts) > 1 else ""
        gtxt = strip_html(g)
        for k, (aid, t) in enumerate(segs):
            if k == len(segs) - 1 or not suffix:
                full = t
            elif suffix == last_txt and not INST_RE.search(t):
                full = f"{t}, {suffix}"      # dept + institution
            elif suffix == last_txt:
                full = t
            else:
                full = f"{t}, {suffix}"
            affs[aid] = {"text": full.strip(" ,;."), "dept": t.split(",")[0].strip(), "group_text": gtxt}
    return authors, affs

def parse_dt(s):
    if not s:
        return None
    for fmt in ("%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s.strip(), fmt).replace(tzinfo=TZ)
        except ValueError:
            pass
    return None

def iso(s):
    d = parse_dt(s)
    return d.isoformat() if d else None

def af(obj, key):
    for f in obj.get("AdditionalFields") or []:
        if f.get("Key") == key:
            return f.get("Value") or ""
    return ""

def split_list(v):
    return [x.strip().lstrip("+").strip() for x in (v or "").split(",") if x.strip().strip("+")]

# ---------------------------------------------------------------- stage: build
def stage_build(people):
    # --- load presentations
    pres, sessions = {}, {}
    for fn in os.listdir(cpath("session_pres", "x")[:-1]):
        for p in json.load(open(cpath("session_pres", fn))) or []:
            pres[p["Id"]] = p
    pdir = os.path.join(RAW, "presentation")
    if os.path.isdir(pdir):
        for fn in os.listdir(pdir):
            p = json.load(open(os.path.join(pdir, fn)))
            if p:
                pres.setdefault(p["Id"], p)
    for fn in os.listdir(os.path.join(RAW, "session")):
        s = json.load(open(os.path.join(RAW, "session", fn)))
        if s:
            sessions[s["Id"]] = s
    print(f"[build] {len(pres)} presentations, {len(sessions)} sessions in cache")

    # --- roster indices
    by_last = {}
    for p in people.values():
        by_last.setdefault(norm(p["last"]), []).append(p)
        # also index last word of multi-word last names and hyphen parts
    name_hits = {}   # pres id -> [(atlas_id, query)]
    for p in people.values():
        for q in p["queries"]:
            h = hashlib.sha1(q.encode()).hexdigest()[:16]
            fp = os.path.join(RAW, "search", "presentation", h + ".json")
            if os.path.exists(fp):
                for r in json.load(open(fp))["results"]:
                    name_hits.setdefault(r["Id"], []).append((p["atlas_id"], q))
    affil_hits = {}
    affil_counts = {}
    for q in AFFIL_PHRASES:
        h = hashlib.sha1(q.encode()).hexdigest()[:16]
        fp = os.path.join(RAW, "search", "presentation", h + ".json")
        if os.path.exists(fp):
            d = json.load(open(fp))
            affil_counts[q] = int(d["search"].get("Count") or 0)
            for r in d["results"]:
                affil_hits.setdefault(r["Id"], []).append(q)

    def roster_match(au, is_w, pid):
        """Match a parsed author to roster people. Returns (person, confidence, note) or None."""
        cands = by_last.get(norm(au["last"]), [])
        if not cands and " " in au["last"]:
            cands = by_last.get(norm(au["last"].split()[-1]), [])
        ini = [norm(x)[:1] for x in re.split(r"[\s.\-]+", au["initials"]) if norm(x)]
        if not ini and " " in au["name"]:  # full-name style e.g. "Linda Richards"
            ini = [norm(au["name"].split()[0])[:1]]
        out = []
        for c in cands:
            fi = {norm(v)[:1] for v in first_variants(c["first"])}
            if ini and ini[0] in fi:
                out.append(c)
        if not out:
            return None
        if len(out) > 1:  # use middle initial / name-search to pick
            mid = [c for c in out if c["middle"] and len(ini) > 1 and norm(c["middle"])[:1] == ini[1]]
            nh = [c for c in out if any(a == c["atlas_id"] for a, _ in name_hits.get(pid, []))]
            pick = nh or mid
            if len(pick) == 1:
                out = pick
            else:
                return {"person": None, "candidates": [c["atlas_id"] for c in out],
                        "confidence": "ambiguous", "note": "several roster people share last name + first initial"}
        c = out[0]
        by_search = any(a == c["atlas_id"] for a, _ in name_hits.get(pid, []))
        if not is_w:
            return {"person": c, "confidence": "rejected_non_washu",
                    "note": "name matches roster but author affiliation is not WashU"}
        mid_ok = None
        if c["middle"] and len(ini) > 1:
            mid_ok = norm(c["middle"])[:1] == ini[1]
        if by_search:
            conf, note = "high", "quoted full-name search hit + WashU affiliation"
        elif mid_ok is False:
            conf, note = "low", "last name + first initial + WashU, but middle initial differs"
        else:
            conf, note = "medium", "last name + first initial + WashU affiliation (no full-name search hit; could be a namesake trainee)"
        return {"person": c, "confidence": conf, "note": note}

    out_pres, people_idx = [], {}
    CHAIR_RE = re.compile(r"chair|organi[sz]er|moderator|host|facilitator", re.I)
    def _washu_any(p):
        t = strip_html(p.get("AuthorBlock"))
        return is_washu(t) or is_washu_probable(t)
    chaired = {p.get("SessionId") for p in pres.values()
               if _washu_any(p) and (CHAIR_RE.search(p.get("Activity") or "") or CHAIR_RE.search(strip_html(p.get("Title"))[:40]))}
    washu_titled = {sid for sid, s in sessions.items()
                    if is_washu(strip_html((s.get("Title") or "") + " " + (s.get("Description") or "")))}
    chaired |= washu_titled
    used_sessions = set()
    for pid, p in pres.items():
        authors, affs = parse_author_block(p.get("AuthorBlock"))
        ablock_text = strip_html(p.get("AuthorBlock"))
        any_washu_block = is_washu(ablock_text)
        aout, reasons, flags = [], [], set()
        pres_is_washu = False
        for idx, au in enumerate(authors):
            atexts = [affs[i]["text"] for i in au["aff_ids"] if i in affs]
            w = any(is_washu(t) for t in atexts)
            wp = (not w) and any(is_washu_probable(t) for t in atexts)
            neuro = any(is_washu(affs[i]["text"]) and NEURO_DEPT_RE.match(affs[i]["dept"] or "") for i in au["aff_ids"] if i in affs)
            m = roster_match(au, w or wp, pid)
            if m and wp and m.get("person") and m["confidence"] in ("high", "medium"):
                m["confidence"] = "medium" if m["confidence"] == "high" else "low"
                m["note"] += " (affiliation is only 'St. Louis, MO' with no institution named)"
            rec = {"position": idx + 1, "name": au["name"], "initials": au["initials"], "last": au["last"],
                   "presenting": au["presenting"], "affiliation_ids": au["aff_ids"], "affiliations": atexts,
                   "is_washu": w, "is_washu_probable": wp, "is_washu_dept_neuroscience": neuro,
                   "is_don_roster": False, "is_washu_roster": False, "atlas_id": None,
                   "roster_name": None, "roster_department": None, "match_confidence": None, "match_note": None}
            if m:
                rec["match_confidence"], rec["match_note"] = m["confidence"], m["note"]
                if m.get("person") and m["confidence"] != "rejected_non_washu":
                    c = m["person"]
                    rec.update(is_don_roster=c["is_DoN"], is_washu_roster=True, atlas_id=c["atlas_id"],
                               roster_name=c["display_name"], roster_department=c["department"])
                elif m.get("candidates"):
                    rec["atlas_id_candidates"] = m["candidates"]
            if au["presenting"] and w:
                pres_is_washu = True
            aout.append(rec)
        # presenter fallback when no '*' marker (invited talks): first author == presenter
        if not any(a["presenting"] for a in authors) and aout:
            pres_is_washu = aout[0]["is_washu"]
        washu_authors = [a for a in aout if a["is_washu"]]
        probable_authors = [a for a in aout if a["is_washu_probable"]]
        roster_authors = [a for a in aout if a["is_washu_roster"]]
        don_authors = [a for a in roster_authors if a["is_don_roster"]]
        neuro_authors = [a for a in aout if a["is_washu_dept_neuroscience"]]
        session_context = False
        if not (washu_authors or any_washu_block or probable_authors):
            # name-pass hits without any WashU affiliation are ignored (namesakes)
            if p.get("SessionId") in chaired:
                session_context = True   # non-WashU talk inside a session a WashU person chairs/organizes
            else:
                continue
        if washu_authors:
            reasons.append("affiliation: author with WashU affiliation in AuthorBlock")
        elif any_washu_block:
            reasons.append("affiliation: WashU text in AuthorBlock (author link unparsed)")
        elif probable_authors:
            reasons.append("affiliation_probable: author affiliation is 'St. Louis, MO' with no institution named")
        elif session_context:
            reasons.append("session_context: no WashU author, but the session is chaired/organized by a WashU person")
        for a in roster_authors:
            reasons.append(f"roster: {a['roster_name']} ({a['atlas_id']}, {'DoN' if a['is_don_roster'] else 'WashU-other'}; {a['match_confidence']})")
        for aid, q in name_hits.get(pid, []):
            reasons.append(f"name_search: {q} -> {people[aid]['display_name']}")
        for q in affil_hits.get(pid, []):
            reasons.append(f"affil_search: {q}")
        if don_authors: flags.add("don_roster_author")
        if neuro_authors: flags.add("washu_dept_neuroscience_author")
        if pres_is_washu: flags.add("presenter_is_washu")
        if any(a["is_washu_roster"] and not a["is_don_roster"] for a in aout): flags.add("other_washu_roster_author")
        if aout and aout[0]["is_washu"]: flags.add("first_author_washu")
        if aout and len(aout) > 1 and aout[-1]["is_washu"]: flags.add("last_author_washu")
        if any(a["is_don_roster"] and a["position"] == len(aout) for a in aout) and len(aout) > 1: flags.add("don_roster_senior_author")
        conf = ("context" if session_context else "high" if (don_authors and any(a["match_confidence"] == "high" for a in don_authors)) or neuro_authors
                else "medium" if don_authors else "washu_only")
        if don_authors or neuro_authors:
            don_link = "don"
        elif roster_authors:
            don_link = "washu_neuro_directory"
        elif washu_authors or any_washu_block:
            don_link = "washu_other"
        elif probable_authors:
            don_link = "washu_probable"
        else:
            don_link = "session_context"
        if p.get("SessionId") in chaired: flags.add("in_washu_chaired_session")
        if p.get("SessionId") in washu_titled:
            flags.add("washu_named_session")
            reasons.append("session: session title/description names Washington University")

        s = sessions.get(p.get("SessionId")) or {}
        used_sessions.add(p.get("SessionId"))
        start_iso, end_iso = iso(p.get("Start")), iso(p.get("End"))
        topics = split_list(af(p, "Topics"))
        keywords = split_list(af(p, "Keywords"))
        stype = s.get("Type") or af(p, "SessionTypeatControlLevel")
        num = p.get("PresentationNumber") or ""
        is_poster = bool(p.get("PosterboardNumber")) or num.startswith(("PSTR", "LBP"))
        rec = {
            "id": pid, "presentation_number": num, "control_number": p.get("ControlNumber"),
            "title": strip_html(p.get("Title")), "title_html": p.get("Title"),
            "abstract": strip_html(p.get("Abstract")), "abstract_html": p.get("Abstract"),
            "activity": p.get("Activity"), "status": p.get("Status"),
            "format": "poster" if is_poster else ("talk" if p.get("Activity") in ("Speaker", "Scientific Abstract", "Presenter") else (p.get("Activity") or "other").lower()),
            "is_poster": is_poster,
            "presenter": p.get("PresenterDisplayName"), "presenter_is_washu": pres_is_washu,
            "authors": aout, "author_block_html": p.get("AuthorBlock"), "author_block_text": ablock_text,
            "affiliations": [{"id": k, **v, "is_washu": is_washu(v["text"])} for k, v in affs.items()],
            "date": (start_iso or "")[:10] or s.get("Date"), "start": start_iso, "end": end_iso,
            "room": s.get("Location"), "posterboard": p.get("PosterboardNumber") or None,
            "position_in_session": p.get("PositionInSession"),
            "session": {"id": p.get("SessionId"), "number": s.get("Number"),
                        "title": strip_html(p.get("SessionTitle") or s.get("Title")),
                        "type": stype, "location": s.get("Location"),
                        "start": iso(s.get("Start")), "end": iso(s.get("End")),
                        "url": f"{PP8}/session/{p.get('SessionId')}" if p.get("SessionId") else None},
            "theme": [t.split(" – ")[0] for t in topics], "topics": topics, "keywords": keywords,
            "citation": strip_html(af(p, "Citation")), "disclosures": strip_html(p.get("DisclosureBlock")),
            "url": f"{PP8}/presentation/{pid}",
            "session_url": f"{PP8}/session/{p.get('SessionId')}" if p.get("SessionId") else None,
            "washu_probable_authors": [a["name"] for a in probable_authors],
            "washu_authors": [{"name": a["name"], "position": a["position"], "atlas_id": a["atlas_id"],
                               "is_don_roster": a["is_don_roster"], "dept_neuroscience": a["is_washu_dept_neuroscience"]} for a in washu_authors],
            "don_roster_authors": [{"name": a["name"], "atlas_id": a["atlas_id"], "roster_name": a["roster_name"], "confidence": a["match_confidence"]} for a in don_authors],
            "any_author_dept_neuroscience_washu": bool(neuro_authors),
            "don_link": don_link, "don_flags": sorted(flags), "confidence": conf,
            "match_reasons": reasons,
            "found_by_name_search": pid in name_hits, "found_by_affil_search": pid in affil_hits,
        }
        out_pres.append(rec)
        for a in roster_authors:
            people_idx.setdefault(a["atlas_id"], set()).add(pid)
    out_pres.sort(key=lambda r: (r["start"] or "9", r["presentation_number"]))

    # --- sessions with WashU chairs/organizers or WashU presentations
    sess_out = {}
    for r in out_pres:
        sid = r["session"]["id"]
        s = sessions.get(sid) or {}
        e = sess_out.setdefault(sid, {
            "id": sid, "number": s.get("Number"), "title": strip_html(s.get("Title")), "type": s.get("Type"),
            "date": s.get("Date"), "start": iso(s.get("Start")), "end": iso(s.get("End")),
            "location": s.get("Location"), "description": strip_html(s.get("Description")),
            "curated_topics": split_list(af(s, "Curated")), "mobile_app_type": af(s, "MobileAppType"),
            "objectives": [x for x in (af(s, "Objective1"), af(s, "Objective2"), af(s, "Objective3")) if x],
            "presentation_count": af(s, "Presentation Count"), "url": f"{PP8}/session/{sid}",
            "washu_roles": [], "washu_presentation_ids": [], "washu_chair_or_organizer": False, "don_linked": False})
        e.setdefault("context_presentation_ids", [])
        if r["don_link"] == "session_context":
            e["context_presentation_ids"].append(r["id"]); continue
        e["washu_presentation_ids"].append(r["id"])
        act = (r["activity"] or "")
        if re.search(r"chair|organi[sz]er|moderator|host", act, re.I) or re.search(r"\b(Chair|Organizer|Moderator)\b", r["title"] or ""):
            e["washu_chair_or_organizer"] = True
            e["washu_roles"].append({"role": act or r["title"], "presentation_id": r["id"], "people": [a["name"] for a in r["authors"] if a["is_washu"]]})
        if r["don_link"] == "don":
            e["don_linked"] = True
    sess_list = sorted(sess_out.values(), key=lambda s: (s["start"] or "9", s["number"] or ""))

    # --- people index
    pidx = []
    for p in sorted(people.values(), key=lambda x: (not x["is_DoN"], x["last"])):
        ids = sorted(people_idx.get(p["atlas_id"], []), key=lambda i: next((r["start"] or "" for r in out_pres if r["id"] == i), ""))
        pidx.append({"atlas_id": p["atlas_id"], "name": p["display_name"], "full_name_as_listed": p["full_name_as_listed"],
                     "department": p["department"], "is_DoN": p["is_DoN"], "orcid": p.get("orcid"),
                     "lab_website": p.get("lab_website"), "queries": p["queries"],
                     "name_search_hits_total": sum(1 for k, v in name_hits.items() for a, _ in v if a == p["atlas_id"]),
                     "presentation_ids": ids, "n_presentations": len(ids)})

    os.makedirs(HERE, exist_ok=True)
    json.dump(out_pres, open(os.path.join(HERE, "presentations.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(sess_list, open(os.path.join(HERE, "sessions.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(pidx, open(os.path.join(HERE, "people_index.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    cols = ["id", "presentation_number", "title", "format", "activity", "date", "start", "end", "room", "posterboard",
            "session_number", "session_title", "session_type", "presenter", "presenter_is_washu", "don_link", "confidence",
            "don_flags", "don_roster_authors", "washu_authors", "authors", "themes", "topics", "keywords",
            "url", "session_url", "found_by_name_search", "found_by_affil_search", "match_reasons", "abstract"]
    with open(os.path.join(HERE, "presentations.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols); w.writeheader()
        for r in out_pres:
            w.writerow({**{k: r.get(k) for k in cols if k in r},
                        "session_number": r["session"]["number"], "session_title": r["session"]["title"],
                        "session_type": r["session"]["type"],
                        "don_flags": "; ".join(r["don_flags"]),
                        "don_roster_authors": "; ".join(f"{a['roster_name']} ({a['atlas_id']})" for a in r["don_roster_authors"]),
                        "washu_authors": "; ".join(a["name"] for a in r["washu_authors"]),
                        "authors": "; ".join(f"{a['name']}{' [WashU]' if a['is_washu'] else ''}" for a in r["authors"]),
                        "themes": "; ".join(sorted(set(r["theme"]))), "topics": "; ".join(r["topics"]),
                        "keywords": "; ".join(r["keywords"]), "match_reasons": " | ".join(r["match_reasons"])})
    kept = {r["id"] for r in out_pres if r["don_link"] != "session_context"}
    stats = {"generated": datetime.now(TZ).isoformat(timespec="seconds"),
             "presentations_in_meeting": len(pres), "sessions_in_meeting": len(sessions),
             "washu_presentations": len(out_pres), "sessions_out": len(sess_list),
             "affil_search_counts": affil_counts,
             "affil_search_hits_in_dataset": {q: sum(1 for i, qs in affil_hits.items() if q in qs and i in kept) for q in affil_counts},
             "affil_search_hits_not_washu_author": {q: sum(1 for i, qs in affil_hits.items() if q in qs and i not in kept) for q in affil_counts},
             "name_hits_total": len(name_hits),
             "name_hits_kept": sum(1 for i in name_hits if i in kept),
             "name_hits_rejected_no_washu_affil": sum(1 for i in name_hits if i in pres and i not in kept),
             "name_hits_missing_from_crawl": sorted(i for i in name_hits if i not in pres),
             "washu_presentations_not_found_by_any_search": sum(1 for r in out_pres if r["don_link"] != "session_context" and not r["found_by_name_search"] and not r["found_by_affil_search"])}
    json.dump(stats, open(os.path.join(HERE, "stats.json"), "w"), indent=1)
    print(json.dumps(stats, indent=1))
    return out_pres, sess_list, pidx

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", nargs="?", default="all", choices=["all", "crawl", "names", "affil", "build"])
    ap.add_argument("--delay", type=float, default=0.8)
    ap.add_argument("--refresh-lists", action="store_true", help="re-run the '*' list searches (new sessions/presentations)")
    a = ap.parse_args()
    os.makedirs(RAW, exist_ok=True)
    people = load_roster()
    cl = Client(a.delay)
    # one crawler at a time, sequentially (do not run several harvest.py processes in parallel)
    if a.stage in ("all", "crawl"): stage_crawl(cl, a.refresh_lists)
    if a.stage in ("all", "affil"): stage_affil(cl)
    if a.stage in ("all", "names"): stage_names(cl, people)
    if a.stage in ("all", "build"): stage_build(people)

if __name__ == "__main__":
    main()
