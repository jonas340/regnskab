# Regnskab

En webapp (PWA) til kørsel, bilag og fakturaer. Den ligger som statiske filer på GitHub Pages, og data bor i Supabase.

**Hvad den kan**

- **Overblik:** resultat for året, indtægter mod udgifter pr. måned, udestående og forfaldne fakturaer, kørsel, udgifter fordelt på kategori og moms (hvis du er momsregistreret).
- **Kørsel:** hurtigknapper til faste ture (ét tryk logger turen, med "Fortryd"), ellers en kort formular. Værdien regnes efter SKATs takster med skift ved grænsen.
- **Bilag:** tag foto eller vælg PDF. Claude aflæser leverandør, dato, beløb, moms og kategori, og du godkender med ét tryk.
- **Salg:** fakturaer med fortløbende numre, PDF der kan deles direkte til Mail, status (kladde, sendt, betalt, forfalden) og andre indtægter uden faktura.
- **Mere:** virksomhedsoplysninger, satser, faste ture og CSV-eksport.

---

## Opsætning (ca. 30 minutter)

### 1. Supabase
1. Opret et gratis projekt på supabase.com. Vælg region **Frankfurt (eu-central-1)**.
2. Åbn **SQL Editor**, indsæt hele `supabase/schema.sql` og tryk **Run**.
3. Gå til **Authentication → Users → Add user**. Opret dig selv med e-mail og adgangskode (min. 8 tegn), og sæt flueben i *Auto Confirm User*.
4. Gå til **Authentication → Sign In / Providers** og slå **Allow new users to sign up** fra. Så er det kun dig, der kan logge ind.
5. Kopiér din bruger-ID fra Users-listen. Du skal bruge den i trin 3.

### 2. config.js
Under **Project Settings → API** finder du *Project URL* og *anon public key*. Indsæt dem i `config.js`. Anon-nøglen er lavet til at ligge i frontend. Din data er låst af login og Row Level Security.

### 3. Upload-funktionen (aflæsning af bilag)
Du skal bruge [Supabase CLI](https://supabase.com/docs/guides/cli) og en API-nøgle fra console.anthropic.com. Kør fra projektets rodmappe:

```bash
supabase login
supabase link --project-ref DIT-PROJEKT-ID

supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set OWNER_USER_ID=DIN-BRUGER-ID
supabase secrets set INGEST_TOKEN=$(openssl rand -hex 24)

supabase functions deploy ingest-receipt --no-verify-jwt
```

Gem værdien af `INGEST_TOKEN`, du skal bruge den i genvejen. Har du ikke en `supabase/config.toml`, så kør `supabase init` først. Den rører ikke din funktionsmappe.

`OWNER_USER_ID` betyder, at ingen andre end dig kan bruge funktionen og dermed dine API-kreditter. Dens standardmodel er `claude-sonnet-5-5`. Vil du ændre den, sæt `ANTHROPIC_MODEL`.

### 4. GitHub Pages
1. Læg alle filer i et GitHub-repo.
2. **Settings → Pages → Deploy from a branch → main / (root)**.
3. Åbn adressen i Safari på din iPhone, log ind, tryk **Del → Føj til hjemmeskærm**.

Repoet kan være privat, hvis din GitHub-plan understøtter Pages på private repos. Ellers er det offentligt, og det er også OK, for ingen af filerne indeholder hemmeligheder.

---

## iOS-genvej: del en kvittering direkte fra Mail, Filer eller Safari

Åbn **Genveje**, opret en ny genvej og kald den fx *Gem bilag*. Navnene på handlingerne kan afvige lidt på dansk iOS.

1. Tryk på ⓘ og slå **Vis i delingsark** til. Under *Accepterer* vælger du kun **Billeder** og **PDF-filer**.
2. **Hvis** *Genvejsinput* **er** et billede: tilføj **Konvertér billede** til **JPEG**. Tilføj bagefter **Ændr størrelse på billede** med længste side 2000. Tilføj **Slut hvis**. (HEIC afvises af funktionen, og billeder over 5 MB også.)
3. Tilføj **Spørg efter input** (tekst, valgfri note, fx *Hvad var det til?*).
4. Tilføj **Hent indhold af URL**:
   - URL: `https://DIT-PROJEKT-ID.supabase.co/functions/v1/ingest-receipt` (står også under *Mere* i appen)
   - Metode: **POST**
   - Overskrifter: `x-upload-token` = din `INGEST_TOKEN`
   - Anmodningstekst: **Formular**. Tilføj felt af typen **Fil** med navnet `file`, værdi *Genvejsinput* (eller det konverterede billede). Tilføj felt af typen **Tekst** med navnet `note`, værdi *Bedt om input*.
5. Tilføj **Vis notifikation** med teksten *Bilag sendt*.

Bagefter dukker bilaget op under **Bilag → Til godkendelse**.

Mister du telefonen, eller deler du tokenet ved et uheld, så kør `supabase secrets set INGEST_TOKEN=...` med en ny værdi og opdatér genvejen.

---

## Gode at vide

**Indtægter tælles, når fakturaen er markeret betalt** (kontantprincip), med betalingsdatoen. Er du på fakturaprincip, skal logikken i `calc()` i `app.js` ændres, så den bruger fakturadatoen.

**Kørselstakster** er sat til 3,94 og 2,28 kr./km med grænse ved 20.000 km. Tjek SKATs satser for det aktuelle år og ret dem under *Mere → Virksomhed og satser*.

**Moms på fakturaer** er som standard slået fra. Om dine ydelser er momsfri eller ikke, afgør du (eller din revisor). Appen regner kun med det, du vælger.

**Bogføringsloven:** Appen er et praktisk værktøj til registrering. Om den opfylder kravene til dit regnskab, afhænger af din virksomhedstype og størrelse. Tjek det, og gem bilag i det tidsrum, loven kræver. Udstedte fakturaer kan ikke slettes, kun annulleres, så numrene er sammenhængende.

**Backup:** Eksportér CSV'er fra *Mere* en gang imellem. Bilagsfilerne ligger i Supabase Storage (bucket `receipts`).

**Fremmed valuta:** Er et bilag i fx EUR, viser appen det og beder dig skrive beløbet i kroner.

## Næste skridt (ikke bygget endnu)

- CSV-import fra banken og automatisk afstemning mod fakturaer (beløb + fakturanummer i teksten).
- Videresend kvitteringer pr. mail til en dedikeret adresse.
- Tesla-kilometerstand som alternativ til manuel kørselsregistrering.

## Filer

| Fil | Indhold |
|---|---|
| `index.html`, `style.css`, `app.js` | selve appen |
| `config.js` | dine Supabase-nøgler |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | installation på hjemmeskærmen |
| `supabase/schema.sql` | tabeller, sikkerhed og fillager |
| `supabase/functions/ingest-receipt/` | upload og aflæsning af bilag |
