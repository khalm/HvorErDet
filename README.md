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

1. GPS og kompass sier hvor du står og hvilken vei kameraet peker.
2. Adressene hentes fra Kartverkets åpne adresse-API (Matrikkelen).
3. Husomriss hentes fra OpenStreetMap (i Norge importert fra Matrikkelen), og terrenghøyde
   fra Kartverkets høydemodell (1 m oppløsning).
4. Hver adresse kobles til huset sitt. Appen sender stråler ut fra der du står og regner ut hvilke hus
   du faktisk ser – hus bak andre hus skjules, mens hus oppe i en li vises – og setter adressen midt på fasaden.

### Når det ikke treffer helt
- **Dra labelene** med fingeren til de står på riktig hus (sidelengs = kompass, opp/ned = vipping).
  Frys bildet først, så er det lettere. Justeringen huskes.
- **Unøyaktig GPS?** Trykk 🗺 og «📍 Jeg står her», og trykk på kartet der du står.
- **På balkong / i 2. etasje?** Øk «Øyehøyde over bakken» under ⚙︎.

## Teknisk

Ren HTML/CSS/JavaScript uten byggesteg. Hver gang noe blir pushet til `main`, publiserer
GitHub Actions appen til GitHub Pages automatisk (`.github/workflows/pages.yml`).

Adressedata © Kartverket og © OpenStreetMap-bidragsytere.
