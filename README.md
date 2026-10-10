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

## Afholdte og kommende kurser

Status følger datoen: kurser til og med i dag er **afholdt**, senere kurser er **planlagt** og vises under **Kommende kurser** (tidligere kaldt ordrebogen).
Dashboardets nøgletal tæller kun afholdte kurser; kommende kurser vises for sig. Deltagere kan stå tomt på planlagte kurser.

**Foreløbig:** et kursus med dato, som skolen eller kommunen endnu ikke har godkendt endeligt.
Sæt flueben i formularen, eller klik på status-mærket i listen (kun Kompas-admin). Foreløbige kurser vises med stiplet orange
kant, ligger under Kommende kurser ("heraf N foreløbige") og tæller aldrig som afholdt, før de er godkendt. I kalender-feedet
får titlen "(Foreløbig)" foran. Ved import sætter en kolonne "Status" med "Foreløbig" (eller fx "Afventer") mærket.

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

Alle ark i filen læses (ark uden genkendelige overskrifter springes over). Har arkene hver sin overskrift over tabellen
(fx "LÆRERE" og "PÆDAGOGER"), sættes den på titlen ("Modul 1 – Lærere"). Øverst på siden kan man vælge reseller, betaler og
kommune til felter, filen ikke selv udfylder. Kurser, der ligner noget allerede registreret (samme dag, skole og konsulent),
er fravalgt i forhåndsvisningen og kan vælges til med et flueben. Datoer som 11/26/26 (måned først) læses, når dag-først er umulig.
Tidspunkter er valgfrie og skrives med 24-timers ur: kolonnerne *Starttid* og *Sluttid*, én kolonne *Tid* med fx "9-12",
eller et klokkeslæt i datoen ("19.02.2026 09:00").

**Tidspunkter.** Et kursus kan have et valgfrit start- og sluttidspunkt (tt:mm). Med tid bliver kurset en tidsbestemt aftale i
kalenderabonnementet (uden sluttid: 3 timer for en halv dag, 7 for en hel); uden tid forbliver det en heldagsaftale.
Dobbeltbooking advarer kun, når tiderne overlapper, eller når et af kurserne mangler start- eller sluttid.

SheetJS 0.18.5 fra npm bruges til Excel. Til drift anbefales den nyeste version fra cdn.sheetjs.com.

## Flere konsulenter og dublering

Under *Registrér aktivitet* kan man vælge flere konsulenter; der oprettes ét kursus pr. konsulent med samme antal
deltagere. Et eksisterende kursus kan dubleres med knappen *Dublér kursus*: alle felter kopieres, og man vælger
konsulent(er) igen.

## Kalender (Apple Kalender / iCal)

- **Månedskalender:** Kalender-siden viser en måned ad gangen med afholdte (mørke) og planlagte (orange) kurser. Kompas ser også
  aftaler fra sin kalender, der ikke er registreret endnu (stiplede). Klik på en dag for at se kurserne, åbne dem eller registrere et nyt
  kursus på den dato. Resellere ser kun deres egne kurser.

- **Fra kalender:** Kompas-admin indsætter det offentlige iCal-link til sin kalender (Kalender › Del kalender › Offentlig kalender) under *Kalender*, eller uploader en .ics-fil. Aftaler fra de seneste 4 måneder og de næste 2 vises som forslag, med skole, kommune, emne og varighed udfyldt. Registrerede og skjulte aftaler forsvinder fra listen.
- **Til kalender:** Hver bruger har et privat abonnementslink (`/calendar/feed/<token>.ics`) med netop de aktiviteter, brugeren må se. Linket kan fornyes, hvis det er delt ved en fejl.
- **Læseadgang (fx Apple):** Rollen "Læseadgang til alle resellere" (`viewer`) ser alle resellers kurser og kan filtrere på reseller, men kan ikke registrere, rette, importere eller administrere. Oprettes under Administration › Brugere og adgang.
- **APL-typer:** Oplæg, Workshop Online, Workshop Fysisk, Sparring, Andet (4. okt. 2026: de gamle typer blev fjernet; grønlandske kurser blev Workshop Online, resten Workshop Fysisk). Importen opretter ikke nye typer; uden type bruges Workshop Online for Grønland og ellers Workshop Fysisk.
- **Hurtig rettelse af deltagere:** Administratorer kan skrive deltagerantal direkte i listen under Aktiviteter og i Overblik (gemmes ved Enter eller når feltet forlades; `PUT /api/activities/:id/participants`).
- **Konsulentside og -kalender:** Under Administration › Konsulenter › Konsulentlink får hver konsulent et privat link til sin egen side (`/k/<token>`) med afholdte og kommende kurser, sessioner til Apple (heldag = 2) og linket til Apples Engagement Checkout Survey, samt et kalenderabonnement med kun egne kurser. Siden minder konsulenten om at registrere sine workshops hos Apple og viser antal workshops i år mod målet på 12. Linkene kan fornyes samme sted.

## Tilmelding til foreløbige kurser

Fungerer som en Doodle. Foreløbige kurser fra i dag og frem, som ikke har nogen konsulent, vises øverst på hver konsulents side (`/k/<token>`), hvor konsulenten trykker **Det kan jeg** ved de kurser, de kan tage (intet svar betyder kan ikke). Tidligere Måske-svar vises stadig for Kompas i skemaet. Kompas opretter et nyt kursus til tilmelding med knappen **Nyt kursus til tilmelding**: kurset gemmes som Foreløbigt uden konsulent og med antallet af konsulenter, der skal bruges. Under fanen **Tilmelding** ser Kompas alle svar i et skema (kan filtreres på kommune), skriver hvor mange konsulenter kurset skal bruge, og trykker **Sæt på** for at vælge konsulenterne. Har konsulenten trykket Det kan jeg, kan de ikke selv melde fra; det gør Kompas ved at klikke på svaret i skemaet. Kun Kan tæller mod det antal, der skal bruges (vist som fx 2/4). Når antallet er nået, lukker kurset for tilmelding og forsvinder fra siden hos de konsulenter, der ikke har svaret; Kompas ser det stadig, markeret Fuld. Den første valgte overtager kurset, de øvrige får hver deres kopi (én konsulent pr. kursus). Kurserne forbliver Foreløbige, indtil de godkendes, og forsvinder fra tilmeldingen.

## Til Apple (APL Engagement Checkout)

Fanen **Til Apple** (kun Kompas) viser afholdte kurser med de oplysninger, Apples APL Engagement Checkout beder specialisten om, i skemaets egen rækkefølge (side 1-4). Værdierne kopieres med ét tryk, og listen kan hentes som Excel/CSV (én række pr. kursus, kolonner i skemaets rækkefølge, datoer som dd/mm/åååå) eller udskrives som PDF. Filtre: år, konsulent, reseller og Ikke sendt / Sendt til Apple. Konsulentens e-mail skrives under Administration › Konsulenter og skolens postnummer under Administration › Skoler. Felter, som kun konsulenten kender (niveau, implementeringsstadie, Experiences Catalog, sessionskontekst), står som "Udfyld selv". Foreløbige og kommende kurser er aldrig med.

På konsulentsiden (`/k/<token>`) har hvert afholdt kursus en knap **Til Apple**, der viser de samme svar til kopiering, og boksen "Registrering hos Apple" kan hente konsulentens egne afholdte kurser som Excel (`/k/<token>/apple`) eller udskrive dem som PDF. Når konsulenten har en Apple-e-mail under Administration › Konsulenter, bruger alle Apple-knapper på siden det personlige Engagement Checkout-link (`https://apple.co/apls-checkout?specialist=…&apple_email=…`), så navn og e-mail er udfyldt. Konsulenten kan selv skrive eller rette sin Apple-e-mail på siden (`PUT /k/<token>/apple-email`).

## Senere udvidelser (ikke bygget)

Apple compliance-mål (fx 34 / 40 workshops) er bevidst ikke implementeret. Dashboardets tal
kommer fra `dashboard()` i `core/api.js`, hvor mål kan sammenlignes, når kravene er kendt.
