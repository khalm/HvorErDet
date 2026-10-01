# HvorErDet

Pek kameraet på hus, så viser appen adressene til husene i bildet.

**Åpne appen:** https://khalm.github.io/hvorerdet/

## Slik bruker du den

1. Åpne lenken over på telefonen (Chrome på Android, Safari på iPhone).
2. Trykk **Start kamera** og gi tilgang til kamera, posisjon og bevegelse/retning.
3. Hold telefonen oppreist og pek mot husene. Adressene dukker opp over husene.
4. Trykk på en adresse for detaljer (postnummer, kommune, gårds- og bruksnummer, kart).
5. **❚❚** fryser bildet så du kan lese i ro. **Liste** viser alle adressene i bildet.

### Installer som app
- **Android (Chrome):** meny ⋮ → *Legg til på startskjermen* / *Installer app*.
- **iPhone (Safari):** Del-knappen → *Legg til på Hjem-skjerm*.

## Hvordan det virker

Appen bruker telefonens GPS og kompass til å finne ut hvor du står og hvilken vei kameraet peker.
Så henter den adressepunkter rundt deg fra Kartverkets åpne adresse-API
(`ws.geonorge.no/adresser`, gratis og uten nøkkel) og viser de som ligger innenfor kameraets synsfelt.

Virker kun i Norge. Nøyaktigheten avhenger av GPS og kompass. Står labelene litt skjevt, kan du
justere kompasset under ⚙︎ Innstillinger.

## Teknisk

Ren HTML/CSS/JavaScript uten byggesteg. Hver gang noe blir pushet til `main`, publiserer
GitHub Actions appen til GitHub Pages automatisk (`.github/workflows/pages.yml`).

Adressedata © Kartverket.
