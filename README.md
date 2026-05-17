# Cysterna App

Aplikacja webowa do rejestrowania tras cysterny paliwowej — wpisy kierowcy
(załadunek / wylew, temperatury, stany licznika, dane Tank) trafiają do
arkusza Google Sheets przez Apps Script web app.

## Funkcje

- **Tryb kierowcy** — PIN-locked, każdy kierowca dodaje siebie przy
  pierwszym uruchomieniu. Wpisuje produkty (paliwo, program, RZ + 15°C,
  temperatury załadunku i wylewu).
- **Tryb biura (archiwalny)** — odblokowywany hasłem (`BIURO_PIN` w
  `kierowca.html`), pozwala wpisywać wpisy z papieru ze stałej listy
  kierowców (`KIEROWCY_BIURO`).
- **Offline-first** — wpisy zapisują się lokalnie i synchronizują z
  arkuszem gdy wróci sieć.

## Linki produkcyjne

| Element | URL |
|---|---|
| Aplikacja kierowcy | https://marcinpodyma40-hub.github.io/cysterna-nowe/kierowca.html |
| Strona startowa | https://marcinpodyma40-hub.github.io/cysterna-nowe/ |
| Arkusz Google Sheets | https://docs.google.com/spreadsheets/d/1PSgKxHIP-hN9-urvQ9CIBcGyMB_kMA-kFvWlg3TVX-8/edit |
| Apps Script web app | hosted przez Google, URL w `kierowca.html` jako `SHEETS_URL` |

## Struktura plików

```
cysterna-nowe/
├── index.html           # landing page (linki do app + arkusza)
├── kierowca.html        # główna aplikacja kierowcy (PIN + formularz wpisu)
├── photos.js            # obsługa załączania zdjęć
├── apps-script/
│   └── Code.gs          # backend: doPost → zapis do arkusza Google Sheets
└── README.md
```

### Frontend (`kierowca.html`)

Jeden plik HTML z inline CSS i JS — żadnych zewnętrznych zależności poza
Google Fonts. Stała `SHEETS_URL` (~linia 397) wskazuje na deployowany
Apps Script. Stała ta jest stabilna między deploymentami (patrz niżej).

### Backend (`apps-script/Code.gs`)

Web app w Google Apps Script:

- `doPost(e)` — przyjmuje JSON z `kierowca.html`, zapisuje wpis trasy
  w zakładce `Wpisy` i po jednym wierszu na produkt w zakładce
  `Produkty` (FK po `Timestamp`).
- `doGet(e)` — health check (`{result:'ok', status:'running'}`).
- `LockService.getScriptLock()` serializuje równoległe POSTy.
- Produkty zapisywane batchem przez `setValues` (jeden round-trip
  zamiast N).
- `SpreadsheetApp.openById(SHEET_ID)` — skrypt nie musi być
  container-bound do arkusza.

## Wdrożenie zmian

### Frontend (`kierowca.html`, `index.html`, `photos.js`)

GitHub Pages auto-deploy z brancha `main`:

```bash
git add kierowca.html
git commit -m "..."
git push origin main
```

Po ~30 sekundach zmiany są live na `marcinpodyma40-hub.github.io/cysterna-nowe/`.
Twardy refresh w przeglądarce (`Ctrl+Shift+R`) jeśli widzisz starą wersję.

### Backend (`apps-script/Code.gs`)

1. Otwórz edytor Apps Script (powiązany z arkuszem albo standalone z
   tym samym `SHEET_ID`).
2. Wklej zawartość `apps-script/Code.gs` zastępując starą wersję.
3. **Manage deployments → Edit (ikona ołówka) → Version: New version
   → Deploy.**

URL deploymentu (`SHEETS_URL` w `kierowca.html`) **nie zmienia się**
przy New version — stała w frontend zostaje stabilna.

Jeśli zmieniła się skala uprawnień (np. nowy scope), Google poprosi
o re-authorize przy pierwszym wywołaniu po deploy.

## Konfiguracja kierowców

- **Tryb kierowcy** — kierowcy dodają się sami przy pierwszym
  logowaniu (imię + PIN, trzymane w `localStorage`).
- **Tryb biura** — `KIEROWCY_BIURO` w `kierowca.html` (lista
  hardkodowana). Hasło dostępu: `BIURO_PIN` (też w `kierowca.html`).
  **Zmień przed produkcją.**

## Schemat danych w arkuszu

Dwie zakładki, łączone przez kolumnę `Timestamp`:

- **`Wpisy`** — jeden wiersz na wpis trasy (kierowca, pojazd, km
  start/koniec, Tank: litry, stan licznika, dystans, spalanie).
- **`Produkty`** — N wierszy na wpis (po jednym na produkt: paliwo,
  program, załadunek RZ + 15°C, wylew RZ + 15°C, 4 temperatury,
  norma ubytek, różnica, status).

Pełna lista kolumn: `HEADERS_TRIPS` i `HEADERS_PRODUCTS` w `Code.gs`.
Skrypt jest idempotentny — dopisuje brakujące nagłówki, nie kasuje
istniejących (legacy kolumny w `Wpisy` z poprzednich wersji zostają).

## Kontakt

Marcin — `marcin.podyma40@gmail.com`
