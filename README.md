# Kompas APL Tracker – version 1

Kompas registrerer APL-aktiviteter én gang. Hver reseller (fx Atea, Comm2IG) logger ind og ser,
filtrerer og eksporterer kun de aktiviteter, hvor **Reseller / partner** er dem selv.

## Kør lokalt

Kræver Node.js 22.5 eller nyere. Ingen database-server er nødvendig (SQLite er indbygget i Node).

```bash
npm install
npm start          # http://localhost:3000
npm test           # tester adgangskontrol og eksport
npm run reset-db   # sletter databasen; eksempeldata genskabes ved næste start
```

Databasen ligger i `data/kompas-apl.db` (kan ændres med `DB_FILE`). Port ændres med `PORT`.

## Opbygning

| Mappe | Indhold |
| --- | --- |
| `core/schema.js` | Datamodel (SQLite). Alle valglister er tabeller, ikke kode. |
| `core/api.js` | Al forretningslogik og adgangskontrol. Reseller-filteret lægges ind i selve SQL-forespørgslen for lister, enkeltaktiviteter, dashboard, filtervalg og eksport. |
| `core/seed.js` | Eksempeldata (98 kommuner, konsulenter, skoler, ca. 35 aktiviteter fordelt på Atea og Comm2IG). |
| `server/` | Express-server, SQLite-forbindelse og login (`server/auth.js`). |
| `public/` | Brugerfladen (ren HTML/CSS/JavaScript, intet build-trin). |
| `test/` | Automatiske tests af dataadskillelse og rettigheder over HTTP. |
| `scripts/build-preview.js` | Bygger `dist/preview.html`: en selvstændig demo, der kører hele appen i browseren. |

## Roller

- **Kompas admin**: ser alt, opretter/redigerer/sletter aktiviteter, administrerer valglister og brugere.
- **Reseller-bruger**: knyttet til én reseller; kan kun læse, filtrere og eksportere egne aktiviteter.

Nye resellere og brugere oprettes under *Administration* uden kodeændringer.

## Login

- **Rigtigt login:** e-mail og adgangskode (scrypt-hash, sessioner i databasen, httpOnly-cookie).
  En Kompas-administrator opretter brugere under *Administration › Brugere og adgang* og trykker
  *Ny engangskode*. Brugeren vælger sin egen adgangskode (mindst 10 tegn) ved første login.
- **Demo-login** (vælg bruger, skift bruger i den grå bjælke) er slået til lokalt og slået **fra**, når
  `NODE_ENV=production`, medmindre `DEMO_LOGIN=on` sættes.
- Den første administrator oprettes fra `ADMIN_EMAIL` og `ADMIN_PASSWORD` ved første start.

## Drift på Render

1. Læg koden i et GitHub-repository.
2. På render.com: **New › Blueprint**, vælg repositoryet. `render.yaml` opretter en webservice
   (Frankfurt, starter-plan) med en disk på 1 GB til databasen.
3. Udfyld `ADMIN_EMAIL` og `ADMIN_PASSWORD`, når Render spørger, og tryk **Apply**.
4. Log ind på adressen `https://kompas-apl-tracker.onrender.com` (eller jeres eget domæne under
   *Settings › Custom Domains*, fx `apl.kompas.dk`) og vælg en ny adgangskode.

Installationen starter uden eksempeldata (`SEED_EXAMPLES=false`), men med kommuner, konsulenter,
resellere, APL-typer og betalere. Render tager daglige snapshots af disken. Eksport til Excel kan
bruges som ekstra sikkerhedskopi.

Uden for Render kan `Dockerfile` bruges; databasen ligger i volumen `/data`.

| Variabel | Betydning |
| --- | --- |
| `NODE_ENV=production` | Slår demo-login fra og sikre cookies til |
| `DB_FILE` | Placering af SQLite-databasen (skal ligge på en vedvarende disk) |
| `SEED_EXAMPLES=false` | Ingen eksempelbrugere og -aktiviteter |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Første administrator |
| `DEMO_LOGIN=on/off` | Tving demo-login til eller fra |
| `PORT` | Port (Render sætter den selv) |

## Afholdt og planlagt (ordrebog)

Status følger datoen: kurser til og med i dag er **afholdt**, senere kurser er **planlagt** og udgør ordrebogen.
Dashboardets nøgletal tæller kun afholdte kurser; ordrebogen vises for sig. Deltagere kan stå tomt på planlagte kurser.

## Bulk-import (Excel/CSV)

Under *Aktiviteter › Importér Excel/CSV* uploader Kompas en .xlsx- eller .csv-fil (skabelon kan downloades).
Filen læses i browseren, og serveren finder selv overskriftsrækken (der må gerne stå en titel over den) og
validerer hver række. Kun en dato er påkrævet. Mangelfulde felter udfyldes og noteres i forhåndsvisningen: manglende
deltagere bliver 0, ukendt varighed bliver halv dag, manglende titel bliver APL-typen, og ukendte kommuner udelades.
Reselleren gættes aldrig, fordi den styrer adgangen: "Atea A/S" genkendes som Atea, og rækker uden reseller får den
reseller, man vælger på siden. Nye skoler, konsulenter, APL-typer og betalere oprettes, og dubletter (samme dato,
titel, skole, reseller og konsulent) springes over.
Flere konsulenter i samme felt ("SR, KB" eller fulde navne) giver ét kursus pr. konsulent, fordi hver konsulent tæller
som et afholdt kursus. Initialer sættes under *Administration › Konsulenter*. Man ser en forhåndsvisning, før noget gemmes.

SheetJS 0.18.5 fra npm bruges til Excel. Til drift anbefales den nyeste version fra cdn.sheetjs.com.

## Flere konsulenter og dublering

Under *Registrér aktivitet* kan man vælge flere konsulenter; der oprettes ét kursus pr. konsulent med samme antal
deltagere. Et eksisterende kursus kan dubleres med knappen *Dublér kursus*: alle felter kopieres, og man vælger
konsulent(er) igen.

## Kalender (Apple Kalender / iCal)

- **Fra kalender:** Kompas-admin indsætter det offentlige iCal-link til sin kalender (Kalender › Del kalender › Offentlig kalender) under *Kalender*, eller uploader en .ics-fil. Aftaler fra de seneste 4 måneder og de næste 2 vises som forslag, med skole, kommune, emne og varighed udfyldt. Registrerede og skjulte aftaler forsvinder fra listen.
- **Til kalender:** Hver bruger har et privat abonnementslink (`/calendar/feed/<token>.ics`) med netop de aktiviteter, brugeren må se. Linket kan fornyes, hvis det er delt ved en fejl.

## Senere udvidelser (ikke bygget)

Apple compliance-mål (fx 34 / 40 workshops) er bevidst ikke implementeret. Dashboardets tal
kommer fra `dashboard()` i `core/api.js`, hvor mål kan sammenlignes, når kravene er kendt.
