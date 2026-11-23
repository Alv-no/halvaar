# Halvaar: svarside for halvårsundersøkelsen

En liten app som lar konsulentene i Alv svare på halvårsundersøkelsen. De logger inn, men svarene lagres uten navn. Innloggingen brukes bare til å vite hvem som har levert, slik at de som mangler kan få en påminnelse.

Runden som ligger inne er 2027-01: åpner mandag 4. januar 2027 kl. 07.00, frist fredag 15. januar 2027 kl. 23.59. Spørsmålene er de 67 som er merket «Med i 2027-01» i Airtable-basen Halvårsundersøkelsen.

## Slik holdes navn og svar fra hverandre

Dette er grunnen til at appen finnes, og det bør kunne etterprøves av alle i Alv.

1. **To lagre uten kobling.** Tabellen `inviterte` sier hvem som er invitert og om de har levert (ja/nei). Tabellen `svar_ko` holder svarene. Ingen av dem har en kolonne som peker på den andre, og ingen av dem har tidspunkt for leveringen.
2. **Ingen rekkefølge å lese ut.** Hver levering skriver hele køen på nytt i tilfeldig rekkefølge og berører alle rader i deltakerlisten. Dermed kan verken radrekkefølge eller Postgres' interne transaksjons-ID-er vise hvilket svar som hører til hvem.
3. **Svar overføres i bolker.** Airtable får svarene i bolker, i tilfeldig rekkefølge, med ett felles tidsstempel for bolken. Før fristen holdes fem tilfeldige svar igjen, og en bolk sendes bare hvis den blir på minst fem. Etter fristen sendes resten.
4. **Airtable får aldri identitet.** Det som sendes er svarene, rundenavnet og bolkens tidsstempel. Ikke navn, e-post eller noe annet om personen.
5. **Admin ser tall, ikke personer.** Adminsiden viser hvor mange som har levert, aldri hvem. Tallet regnes fra svarene, så det endrer seg ikke når noen fjernes fra listen. Ved purring får admin verken vite hvem eller hvor mange som får påminnelsen.
6. **Utkast ligger i nettleseren.** Serveren lagrer ingenting før man leverer. Et levert svar kan ikke hentes frem eller endres.
7. **Telemetri er av.** Appen logger aldri innholdet i en levering, og automatisk sporing er slått av i `app.yaml`.

Alt dette er dekket av testene i `web/test`.

### Det appen ikke kan beskytte mot

- Plattformens tilgangslogg viser at en innlogget bruker har sendt inn noe, og når. Det sier at personen har levert, ikke hva.
- Den som har full administratortilgang til databaseserveren mens innsamlingen pågår, kan i teorien analysere transaksjonsloggen. Appen stoler på at plattformdriften ikke gjør det.
- Fritekst kan kjennes igjen på innhold og skrivestil.

## Oppsett før første utrulling

### 1. Airtable-token

Lag et personlig tilgangstoken på <https://airtable.com/create/tokens>.

- Navn: `Halvaar svarside`
- Scope: bare `data.records:write`
- Tilgang: bare basen «Halvårsundersøkelsen»

Legg tokenet i appens vault under navnet `halvaar-airtable-token`.

### 2. Slack-bot

Lag en app på <https://api.slack.com/apps> i Alvs Slack («From scratch»), for eksempel med navnet «Halvårsundersøkelsen».

- Under «OAuth & Permissions», «Bot Token Scopes»: `chat:write`, `im:write`, `users:read`, `users:read.email`
- Installer appen i arbeidsområdet
- Kopier «Bot User OAuth Token» (begynner med `xoxb-`)

Legg tokenet i appens vault under navnet `halvaar-slack-bot-token`.

### 3. Repo og registrering

1. Legg denne mappen i GitHub-repoet `Alv-no/halvaar`. Imaget heter `ghcr.io/alv-no/halvaar-web`.
2. Push til `main`. Arbeidsflyten i `.github/workflows/web.yml` kjører testene, bygger imaget og oppdaterer `image.tag`.
3. Registrer appen i cluster-repoet med en fil `apps/halvaar.yaml` som peker på repoet.

Dev-klyngen (`alv-dev`) har egne tider i `.halvnais/alv-dev.app.yaml`, slik at siden kan prøves før den ekte runden åpner.

Arbeidsflyten følger plattformens mal. Én ting i `app.yaml` er skrevet etter dokumentasjonen uten å være prøvd på en klynge, og bør sjekkes av den som ruller ut: at `path: /` er riktig måte å eksponere roten på.

### Slik legges hemmelighetene inn

Hemmelighetene ligger i klyngens delte app-vault i Azure Key Vault (`<klynge>-app`). Navnene må begynne med `halvaar-`, ellers får ikke appen lese dem. Når appen er registrert, oppretter plattformen begge nøklene med en tom plassholder.

- Fra Halvnais-dashbordet: åpne appen `halvaar` og sett verdien der. Dashbordet kan skrive verdier, men aldri lese dem.
- Fra Azure-portalen: <https://portal.azure.com/#browse/Microsoft.KeyVault%2Fvaults>, åpne vaulten `<klynge>-app`, «Objects», «Secrets». Finnes nøkkelen, åpne den og velg «New Version». Finnes den ikke, velg «Generate/Import» og bruk navnet over. Krever rollen Key Vault Secrets Officer på vaulten.

### 4. Inviterte

Åpne `/admin`, lim inn listen over inviterte (én per linje: `navn;e-post;slack-id`) og trykk «Legg til». Trykk så «Sjekk Slack-kobling for alle» og «Send en test til meg».

## Drift

- **Adminsiden** ligger på `/admin` og er bare åpen for gruppen `eiere` i `app.yaml` og adressene i `ADMIN_EPOST`.
- **Purring:** juster teksten og trykk «Godkjenn og send påminnelser». Påminnelsen går som direktemelding til alle inviterte som ikke har levert og ikke er merket «Ikke purr». Rett før utsending overføres en bolk til Airtable.
- **Ved fristen** stenger siden av seg selv, og alt som er igjen overføres til Airtable i løpet av et minutt. Feiler Airtable, prøver appen på nytt hvert minutt.
- **Én instans.** `replicas` skal stå på 1.

## Konfigurasjon

| Variabel | Innhold |
| --- | --- |
| `APNER`, `FRIST` | Når runden åpner og stenger, med tidssone, f.eks. `2027-01-04T07:00:00+01:00` |
| `ADMIN_EPOST` | Kommadelt liste over hvem som slipper inn på `/admin` |
| `AIRTABLE_BASE_ID`, `AIRTABLE_TABELL` | Basen og tabellen svarene skrives til |
| `AIRTABLE_TOKEN`, `SLACK_BOT_TOKEN` | Hemmeligheter, se over |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Postgres. `DB_SSL=true` hvis databasen krever TLS |
| `LENKE` | Lenken som legges i påminnelsen. Standard er `https://halvaar.<plattformens sone>/` |
| `DEV_EPOST` | Bare lokalt: later som denne adressen er innlogget |

## Kode

```
web/src/main.js          oppstart
web/src/app.js           HTTP, innlogging, admin, tidsstyring
web/src/lagring.js       all lagring, og reglene for anonymitet
web/src/sporsmal.js      validering av svar
web/src/sporsmal.json    spørsmålene, med felt-ID-er i Airtable
web/src/index.mal.html   svarsiden
web/src/admin.html       adminsiden
web/test                 tester (kjøres mot en ekte Postgres-motor i minnet)
```

Kjør testene med `cd web && npm ci && npm test`.

For en ny runde: bytt ut `sporsmal.json` (nye spørsmål trenger felt i Airtable og felt-ID-ene deres), og sett nye tidspunkter i `app.yaml`.
