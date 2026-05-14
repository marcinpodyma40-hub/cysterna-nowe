// Apps Script web app dla aplikacji Cysterna (kierowca.html -> SHEETS_URL).
// Wkleic do edytora Apps Script powiazanego z arkuszem i wdrozyc jako web app.
// Po zmianie kodu: Manage deployments -> Edit pencil -> Version: New version -> Deploy
// (URL deploymentu nie zmienia sie wtedy, wiec stala SHEETS_URL w kierowca.html jest stabilna).
//
// Architektura:
// - zakladka "Wpisy"    -> jeden wiersz na wpis trasy (header-level: kierowca, pojazd, km, tank)
// - zakladka "Produkty" -> jeden wiersz na produkt, FK do wpisu przez kolumne "Timestamp"
//   (zakladka tworzona automatycznie przez insertSheet jesli nie istnieje).
// Stare kolumny w "Wpisy" (Paliwo, Program, Zaladunek [L], Wylew [L], Korekta [L] itp.)
// pozostaja w arkuszu jako legacy - skrypt ich nie usuwa ani nie zapisuje. Mozna je
// recznie ukryc/usunac z arkusza, bo dane produktowe sa teraz w "Produkty".

const SHEET_TRIPS    = 'Wpisy';
const SHEET_PRODUCTS = 'Produkty';

const HEADERS_TRIPS = [
  'Timestamp','Czas utworzenia','Data','Akcja','Wersja','Koryguje TS','Powód korekty',
  'Kierowca','Pojazd','Ciągnik','Naczepa','Nr WZ','Naftobaza',
  'Km start','Km koniec','Km trasa',
  'Tank litry','Tank stan licznika','Tank dystans km','Spalanie L/100km',
  'Liczba produktów','Wprowadzający'
];

const HEADERS_PRODUCTS = [
  'Timestamp','Nr produktu','Data','Kierowca','Pojazd','Akcja','Wersja',
  'Paliwo','Program','Typ programu','Grawitacja',
  'Załadunek RZ [L]','Załadunek 15°C [L]',
  'Wylew RZ [L]','Wylew 15°C [L]',
  'Temp. załadunku RZ [°C]','Temp. załadunku 15°C [°C]',
  'Temp. wylewu RZ [°C]','Temp. wylewu 15°C [°C]',
  'Norma ubytek [L]','Różnica [L]','Różnica netto [L]',
  'Nadwyżka','Nadwyżka ile [L]','Status','Powód ubytku'
];

function getOrCreateSheet(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

// Idempotentnie zapewnia naglowki: dopisuje brakujace na koncu pierwszego wiersza
// (zachowuje wszystkie istniejace - nie kasuje legacy kolumn).
// Zwraca aktualna liste naglowkow w kolejnosci kolumn arkusza.
function ensureHeaders(sheet, requiredHeaders) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    sheet.appendRow(requiredHeaders);
    sheet.getRange(1, 1, 1, requiredHeaders.length)
         .setFontWeight('bold').setBackground('#0f1f3d').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    return requiredHeaders.slice();
  }
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const missing = requiredHeaders.filter(function(h) { return existing.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, lastCol + 1, 1, missing.length)
         .setFontWeight('bold').setBackground('#0f1f3d').setFontColor('#ffffff');
    return existing.concat(missing);
  }
  return existing;
}

// Mapuje slownik {naglowek -> wartosc} na tablice zgodna z biezaca kolejnoscia kolumn.
// Klucze ktorych nie ma w sheetHeaders sa ignorowane, kolumny bez wartosci dostaja ''.
function buildRow(sheetHeaders, dict) {
  return sheetHeaders.map(function(h) {
    if (!dict.hasOwnProperty(h)) return '';
    const v = dict[h];
    return (v === null || v === undefined) ? '' : v;
  });
}

function doPost(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tripsSheet    = getOrCreateSheet(ss, SHEET_TRIPS);
    const productsSheet = getOrCreateSheet(ss, SHEET_PRODUCTS);

    const tripsHeaders    = ensureHeaders(tripsSheet,    HEADERS_TRIPS);
    const productsHeaders = ensureHeaders(productsSheet, HEADERS_PRODUCTS);

    const data    = JSON.parse(e.postData.contents);
    const akcja   = data.akcja || 'WPIS';
    const wersja  = data.wersja || 1;
    const tank    = data.tankowanie || {};
    const produkty = Array.isArray(data.produkty) ? data.produkty : [];

    // 1) Jeden wiersz w "Wpisy" na caly wpis.
    tripsSheet.appendRow(buildRow(tripsHeaders, {
      'Timestamp':          data.ts,
      'Czas utworzenia':    data.czas_utworzenia,
      'Data':               data.data,
      'Akcja':              akcja,
      'Wersja':             wersja,
      'Koryguje TS':        data.koryguje_ts,
      'Powód korekty':      data.powod_korekty,
      'Kierowca':           data.kierowca,
      'Pojazd':             data.pojazd,
      'Ciągnik':            data.ciagnik,
      'Naczepa':            data.naczepa,
      'Nr WZ':              data.wz,
      'Naftobaza':          data.naftobaza,
      'Km start':           data.kmStart,
      'Km koniec':          data.kmKoniec,
      'Km trasa':           data.km,
      'Tank litry':         tank.litry,
      'Tank stan licznika': tank.stanLicznika,
      'Tank dystans km':    tank.dystansKm,
      'Spalanie L/100km':   tank.spalanieL100km,
      'Liczba produktów':   produkty.length,
      'Wprowadzający':      data.wprowadzajacy
    }));

    // 2) Po jednym wierszu w "Produkty" na kazdy produkt; FK po Timestamp.
    produkty.forEach(function(p, i) {
      productsSheet.appendRow(buildRow(productsHeaders, {
        'Timestamp':         data.ts,
        'Nr produktu':       (p.nrProduktu != null) ? p.nrProduktu : (i + 1),
        'Data':              data.data,
        'Kierowca':          data.kierowca,
        'Pojazd':            data.pojazd,
        'Akcja':             akcja,
        'Wersja':            wersja,
        'Paliwo':            p.paliwo,
        'Program':           p.program,                    // string (np. "15") po patchu w kierowca.html
        'Typ programu':      p.typProg,
        'Grawitacja':        p.grawitacja,
        'Załadunek RZ [L]':       p.zaladunek_RZ,
        'Załadunek 15°C [L]':     p.zaladunek_15,
        'Wylew RZ [L]':           p.rozlane_RZ,
        'Wylew 15°C [L]':         p.rozlane_15,
        'Temp. załadunku RZ [°C]':   p.temp_zaladunek_RZ,
        'Temp. załadunku 15°C [°C]': p.temp_zaladunek_15,
        'Temp. wylewu RZ [°C]':      p.temp_rozlane_RZ,
        'Temp. wylewu 15°C [°C]':    p.temp_rozlane_15,
        'Norma ubytek [L]':       p.normaUbytek,
        'Różnica [L]':            p.roznica,
        'Różnica netto [L]':      p.roznicaNetto,
        'Nadwyżka':               p.nadwyzka,
        'Nadwyżka ile [L]':       p.nadwyzkaIle,
        'Status':                 p.status,
        'Powód ubytku':           p.powodUbytku
      }));
    });

    return ContentService
      .createTextOutput(JSON.stringify({
        result:  'ok',
        trips:   1,
        products: produkty.length
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: 'error', msg: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ result: 'ok', status: 'running' }))
    .setMimeType(ContentService.MimeType.JSON);
}
