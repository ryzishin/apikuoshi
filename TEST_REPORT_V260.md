# v2.6.0 — field-completeness report

Base: http://localhost:6969
Generated: 2026-09-19T08:46:50.792Z
Result: 86 PASS · 0 FAIL · 0 SKIP

## Per-endpoint field completeness

| Endpoint | Path | Status | Rows | ID-complete % | anilistId % | malId % | year % | season % | episodes % | score % | genres % | synonyms % | titleEnglish % | titleNative % |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| trending | /api/trending | 200 | 12 | 0% | 0% | 0% | 0% | 0% | 75% | 0% | 0% | 0% | 0% | 0% |
| popular | /api/popular | 200 | 30 | 0% | 0% | 0% | 0% | 0% | 97% | 0% | 0% | 0% | 0% | 0% |
| spotlight | /api/spotlight | 200 | 9 | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| top-ten | /api/top-ten | 200 | 27 | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| top-rankings | /api/top-rankings?sort=top | 200 | 12 | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| trending-sidebar | /api/trending-sidebar | 200 | 39 | 0% | 0% | 0% | 0% | 0% | 36% | 0% | 0% | 0% | 0% | 0% |
| upcoming | /api/upcoming | 200 | 12 | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| completed | /api/completed | 200 | 5 | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| new-release | /api/new-release | 200 | 40 | 0% | 0% | 0% | 0% | 0% | 73% | 0% | 0% | 0% | 0% | 0% |
| newly-added | /api/newly-added | 200 | 39 | 3% | 3% | 3% | 3% | 0% | 69% | 0% | 3% | 3% | 3% | 3% |
| latest-updated | /api/latest-updated | 200 | 39 | 3% | 3% | 3% | 3% | 0% | 69% | 0% | 3% | 3% | 3% | 3% |
| recently-updated | /api/recently-updated?tab=all | 200 | 12 | 0% | 0% | 0% | 0% | 0% | 75% | 0% | 0% | 0% | 0% | 0% |
| az-list | /api/az-list/a | 200 | 40 | 0% | 0% | 0% | 0% | 0% | 50% | 0% | 0% | 0% | 0% | 0% |
| filter | /api/filter?type=TV | 200 | 30 | 3% | 3% | 3% | 3% | 0% | 87% | 0% | 3% | 3% | 3% | 3% |
| genre | /api/genre/action | 200 | 30 | 0% | 0% | 0% | 0% | 0% | 90% | 0% | 0% | 0% | 0% | 0% |
| type | /api/type/TV | 200 | 30 | 3% | 3% | 3% | 3% | 0% | 90% | 0% | 3% | 3% | 3% | 3% |
| status | /api/status/airing | 200 | 39 | 3% | 3% | 3% | 3% | 0% | 74% | 0% | 3% | 3% | 3% | 3% |
| schedule | /api/schedule | 200 | 18 | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| schedule?date=today | /api/schedule?date=2026-09-19 | 200 | 18 | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| airing | /api/airing | 200 | 18 | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |

## Summary

- Endpoints tested: 20
- Endpoints returning 200: 20
- Endpoints with >= 80% id-completeness: 0
- Endpoints with >= 50% anilistId: 0
- Endpoints with >= 50% year: 0
- Endpoints with >= 50% score: 0
