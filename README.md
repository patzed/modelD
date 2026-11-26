# Modell D

Dynamisk allokering mellan aktier, statsobligationer, kredit, guld och kassa. Den räknas om automatiskt varje kväll av GitHub Actions och publiceras på GitHub Pages.

## Så fungerar det
- Varje kväll kl. 23.30 svensk vintertid (00.30 sommartid) körs `scripts/build.mjs`. Den hämtar:
  - månadsdata från FRED: GS10, TB3MS, BAA10YM, CPIAUCNS
  - dagsdata från FRED: BAA10Y, DGS10, DTB3, SP500
  - CAPE från multpl.com
- Den räknar fram månadens beslut, prognosen för nästa månad och exitkortet, och publicerar sidan.
- Varje dags beslut och prognos sparas i `data/log.csv`.
- Om multpl inte går att läsa används den senast sparade CAPE-serien i `data/cape.json`.

## Engångsinställning
Sidan publiceras på grenen `gh-pages`. Om den inte syns efter första körningen: Settings → Pages → Source: **Deploy from a branch**, välj `gh-pages` och `/ (root)`.

Valfritt: lägg en gratis FRED-nyckel som en secret med namnet `FRED_API_KEY` (Settings → Secrets → Actions). Det gör hämtningen stabilare.

## Köra manuellt
Actions → "Uppdatera Modell D" → Run workflow.

## Installera på mobilen
Öppna sidan i Chrome, tryck på ⋮ och välj **Installera app** eller **Lägg till på startskärmen**.

## Filer
- `lib/model.js`: modellens regler. De ger samma beslut som backtesten i alla 562 månader 1980–2026.
- `lib/backtest.json`: historiken som har räknats fram i förväg.
- `site/`: sidan, manifestet och service worker.

Detta är en modell testad i efterhand, inte investeringsrådgivning. Moody's Baa-data hämtas från FRED vid varje körning och sparas inte i repot.
