# WashU / DoN presentations at SfN Neuroscience 2026 (meeting 21503)

Generated 2026-11-12T12:23:26-05:00. Source: the public abstractsonline planner API (https://www.abstractsonline.com/oe3).

## Method
1. Full-meeting crawl: all 770 sessions and 10014 presentations (cached in raw/).
2. Keep a presentation if any author's affiliation in AuthorBlock mentions Washington University (any variant: Washington Univ., Sch. of Med., in St. Louis, WashU).
3. Tag authors against the Investigator Atlas rosters (544 WashU neuroscience people, 33 DoN faculty) by name, plus quoted name searches with nickname variants. Name hits without a WashU affiliation are rejected (49 rejected).
4. Affiliation phrase searches were run as a diagnostic only; 5 WashU presentations were found only by the crawl.

## Counts
- WashU presentations: 154 (102 posters, 52 talks/other)
- By day: 2026-11-14: 6, 2026-11-15: 31, 2026-11-16: 56, 2026-11-17: 38, 2026-11-18: 23
- With a DoN roster faculty author: 29
- With an author listing Dept. of Neuroscience at WashU: 24
- Sessions with WashU content (sessions.json): 99

## Files
- presentations.json: one object per presentation. Fields: abstract, abstract_html, activity, affiliations, any_author_dept_neuroscience_washu, author_block_html, author_block_text, authors, citation, confidence, control_number, date, disclosures, don_flags, don_link, don_roster_authors, end, format, found_by_affil_search, found_by_name_search, id, is_poster, keywords, match_reasons, position_in_session, posterboard, presentation_number, presenter, presenter_is_washu, room, session, session_url, start, status, theme, title, title_html, topics, url, washu_authors, washu_probable_authors
- presentations.csv: flattened version.
- sessions.json: sessions containing WashU presentations or chairs.
- people_index.json: roster person -> presentation ids.
- stats.json: run statistics.
- harvest.py: `python3 harvest.py [crawl|affil|names|build]`; run stages one at a time (the server times out under parallel load). `build` works offline from raw/.

## Links
`url` = https://www.abstractsonline.com/pp8/#!/21503/presentation/<id> (opens the planner page with Add to Itinerary).

## Known gaps
- Atlas lists PIs only, so trainees are found by affiliation, not by name. DoN membership for non-faculty authors is inferred from "Neurosci." + WashU in the affiliation, which is imperfect (WashU affiliation strings are abbreviated and sometimes split across numbered lines).
- Joint DoN faculty whose home department is elsewhere show as non-DoN in the roster.
- Times are as listed by the planner (Eastern, meeting local).
