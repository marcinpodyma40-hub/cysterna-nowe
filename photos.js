// ============================================================
// CYSTERNA - MODUŁ ZDJĘĆ DOKUMENTÓW
// ============================================================
// Plik: photos.js
// Wersja: 1.0 (sesja 4 - 9.05.2026)
//
// CO ROBI:
//   1. Pobiera trasy z bazy (backend)
//   2. Pokazuje listę tras z dziś i ostatnich 7 dni
//   3. Pozwala kierowcy zrobić 2 zdjęcia (WZ + raport licznika)
//   4. Kompresuje zdjęcia w przeglądarce (5MB -> ~300KB)
//   5. Wysyła do Cloudinary (Unsigned upload)
//   6. Zapisuje linki w bazie (PUT /api/trips/:id/photos)
//
// KONFIGURACJA Cloudinary:
//   - Cloud name:    dfhhevcbt
//   - Upload preset: cysterna_kierowca (Unsigned)
//
// WYMAGA:
//   - Zalogowany kierowca (CysternaBackend)
//   - Działający backend (Railway)
//   - Internet
// ============================================================

var CysternaPhotos = (function(){
  'use strict';

  // ===== KONFIGURACJA =====
  var CFG = {
    CLOUDINARY_CLOUD: 'dfhhevcbt',
    CLOUDINARY_PRESET: 'cysterna_kierowca',
    BACKEND_URL: 'https://cysterna-backend-production.up.railway.app',
    KOMPRESJA_MAX_SZER: 1600,    // max szerokość zdjęcia po kompresji (px)
    KOMPRESJA_JAKOSC: 0.82,       // jakość JPEG (0-1), 0.82 to dobry kompromis
    DNI_HISTORII: 7,              // pokazujemy trasy z ostatnich N dni
    CACHE_KEY: 'cysterna_trasy_z_bazy_cache'
  };

  // ===== HELPERY =====

  // Bezpieczny localStorage
  function lsGetSafe(k) { try { return localStorage.getItem(k); } catch(e) { return null; } }
  function lsSetSafe(k, v) { try { localStorage.setItem(k, v); } catch(e) {} }

  // Token z modułu CysternaBackend
  function getToken() { return lsGetSafe('cysterna_token'); }

  // Zalogowany?
  function isLoggedIn() {
    if (typeof CysternaBackend !== 'undefined' && CysternaBackend.isLoggedIn) {
      return CysternaBackend.isLoggedIn();
    }
    return !!getToken();
  }

  // Format daty czytelny dla człowieka
  function formatujDate(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var dni = ['ndz','pon','wt','śr','czw','pt','sob'];
    var dzis = new Date();
    var wczoraj = new Date(); wczoraj.setDate(wczoraj.getDate()-1);
    if (d.toDateString() === dzis.toDateString()) return 'dziś';
    if (d.toDateString() === wczoraj.toDateString()) return 'wczoraj';
    return dni[d.getDay()] + ' ' + d.getDate() + '.' + (d.getMonth()+1);
  }

  // Sprawdza czy trasa ma komplet zdjęć (WZ + raport)
  function maKompletZdjec(trip) {
    return !!(trip && trip.photo_wz_url && trip.photo_paragon_url);
  }

  // ===== POBIERANIE TRAS Z BAZY =====

  function pobierzTrasy() {
    if (!isLoggedIn()) {
      return Promise.reject(new Error('Nie jesteś zalogowany'));
    }
    var ctrl = new AbortController();
    var timeoutId = setTimeout(function(){ ctrl.abort(); }, 15000);

    return fetch(CFG.BACKEND_URL + '/api/trips?limit=100', {
      headers: { 'Authorization': 'Bearer ' + getToken() },
      signal: ctrl.signal
    }).then(function(res){
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function(json){
      var trasy = (json && json.data) || [];
      // Filtrujemy tylko ostatnie N dni
      var granica = new Date();
      granica.setDate(granica.getDate() - CFG.DNI_HISTORII);
      var filtered = trasy.filter(function(t){
        if (!t.trip_date) return false;
        return new Date(t.trip_date) >= granica;
      });
      // Cache na wypadek offline
      try {
        lsSetSafe(CFG.CACHE_KEY, JSON.stringify({
          ts: Date.now(),
          trasy: filtered
        }));
      } catch(e) {}
      return filtered;
    }, function(err){
      clearTimeout(timeoutId);
      throw err;
    });
  }

  // Cache (jak nie ma sieci)
  function pobierzZCache() {
    try {
      var raw = lsGetSafe(CFG.CACHE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      return (obj && obj.trasy) ? obj.trasy : null;
    } catch(e) { return null; }
  }

  // ===== KOMPRESJA ZDJĘĆ =====

  // Zmniejsza zdjęcie do max szerokości i konwertuje na JPEG ~300KB.
  // Wejście: File (z <input type="file">). Wyjście: Promise<Blob>.
  function kompresujZdjecie(file) {
    return new Promise(function(resolve, reject){
      if (!file || !file.type || !/^image\//.test(file.type)) {
        return reject(new Error('To nie jest zdjęcie'));
      }
      var reader = new FileReader();
      reader.onerror = function(){ reject(new Error('Nie mogę odczytać pliku')); };
      reader.onload = function(e){
        var img = new Image();
        img.onerror = function(){ reject(new Error('Nie mogę otworzyć zdjęcia')); };
        img.onload = function(){
          // Obliczamy nową szerokość (maks 1600px), proporcjonalnie wysokość
          var skala = Math.min(1, CFG.KOMPRESJA_MAX_SZER / img.width);
          var w = Math.round(img.width * skala);
          var h = Math.round(img.height * skala);
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob(function(blob){
            if (!blob) return reject(new Error('Nie udało się skompresować'));
            resolve(blob);
          }, 'image/jpeg', CFG.KOMPRESJA_JAKOSC);
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ===== UPLOAD do Cloudinary =====

  function wyslijDoCloudinary(blob, opisFolder) {
    var url = 'https://api.cloudinary.com/v1_1/' + CFG.CLOUDINARY_CLOUD + '/image/upload';
    var fd = new FormData();
    fd.append('file', blob);
    fd.append('upload_preset', CFG.CLOUDINARY_PRESET);
    if (opisFolder) fd.append('folder', 'cysterna/wz/' + opisFolder);

    var ctrl = new AbortController();
    // Większy timeout, bo upload zdjęcia może trwać na wolnym łączu
    var timeoutId = setTimeout(function(){ ctrl.abort(); }, 60000);

    return fetch(url, {
      method: 'POST',
      body: fd,
      signal: ctrl.signal
    }).then(function(res){
      clearTimeout(timeoutId);
      if (!res.ok) {
        return res.text().then(function(t){
          throw new Error('Cloudinary błąd ' + res.status + ': ' + t);
        });
      }
      return res.json();
    }).then(function(data){
      if (!data.secure_url) throw new Error('Cloudinary nie zwrócił URL');
      return data.secure_url;
    }, function(err){
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') throw new Error('Wysyłanie zdjęcia trwa za długo - sprawdź internet');
      throw err;
    });
  }

  // ===== ZAPIS LINKÓW W BAZIE =====

  function zapiszLinkiWBazie(tripId, urls) {
    var ctrl = new AbortController();
    var timeoutId = setTimeout(function(){ ctrl.abort(); }, 15000);
    return fetch(CFG.BACKEND_URL + '/api/trips/' + tripId + '/photos', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getToken()
      },
      body: JSON.stringify(urls),
      signal: ctrl.signal
    }).then(function(res){
      clearTimeout(timeoutId);
      return res.text().then(function(t){
        var data = null;
        try { data = JSON.parse(t); } catch(e) { data = {raw:t}; }
        if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
        return data;
      });
    }, function(err){
      clearTimeout(timeoutId);
      throw err;
    });
  }

  // ===== STAN APKI (UI) =====

  var _stanModala = null; // { tripId, tripObj, krok, plikWz, plikRaport, blobWz, blobRaport }
  var _aktualneTrasy = []; // ostatnio pobrane trasy

  // ===== RENDEROWANIE LISTY =====

  function renderujEkran() {
    var cont = document.getElementById('foto-list');
    if (!cont) return;
    var info = document.getElementById('foto-status');
    if (info) {
      info.textContent = 'Pobieram trasy z serwera...';
      info.style.display = 'block';
    }
    cont.innerHTML = '<div style="text-align:center;padding:30px;color:#94a3b8;">⏳ Ładowanie...</div>';

    pobierzTrasy().then(function(trasy){
      _aktualneTrasy = trasy;
      renderujListe(trasy, false);
      if (info) info.style.display = 'none';
      odswiezPasekPrzypomnienia();
    }, function(err){
      // Spróbuj cache
      var cache = pobierzZCache();
      if (cache && cache.length) {
        _aktualneTrasy = cache;
        renderujListe(cache, true);
        if (info) {
          info.textContent = '⚠️ Brak internetu - pokazuję ostatnio pobrane trasy. Aby dodać zdjęcia, sprawdź połączenie.';
          info.style.background = '#fef3c7';
          info.style.color = '#92400e';
          info.style.display = 'block';
        }
      } else {
        cont.innerHTML = '<div style="text-align:center;padding:30px;color:#b91c1c;background:#fef2f2;border-radius:10px;">'+
          '<div style="font-size:32px;margin-bottom:8px;">⚠️</div>'+
          '<b>Nie mogę pobrać tras.</b><br><br>'+
          '<span style="font-size:13px;">'+(err.message||'Brak połączenia')+'</span><br><br>'+
          '<button class="btn-sm" onclick="CysternaPhotos.odswiez()">🔄 Spróbuj ponownie</button>'+
          '</div>';
        if (info) info.style.display = 'none';
      }
    });
  }

  function renderujListe(trasy, zCache) {
    var cont = document.getElementById('foto-list');
    if (!cont) return;
    if (!trasy.length) {
      cont.innerHTML = '<div style="text-align:center;padding:30px;color:#94a3b8;">'+
        '<div style="font-size:32px;margin-bottom:8px;">📭</div>'+
        'Brak tras z ostatnich '+CFG.DNI_HISTORII+' dni'+
        '</div>';
      return;
    }
    // Sortuj po dacie malejąco (najnowsze na górze)
    var sortowane = trasy.slice().sort(function(a,b){
      return (b.trip_date || '').localeCompare(a.trip_date || '');
    });
    cont.innerHTML = '';
    sortowane.forEach(function(t){
      cont.appendChild(rysujKarteTrasy(t, zCache));
    });
  }

  function rysujKarteTrasy(t, zCache) {
    var div = document.createElement('div');
    var komplet = maKompletZdjec(t);
    var bgKolor = komplet ? '#f0fdf4' : '#fefce8';
    var ramka = komplet ? '#86efac' : '#fde047';
    div.style.cssText = 'background:'+bgKolor+';border:1px solid '+ramka+';border-radius:10px;padding:12px;margin-bottom:10px;';

    var statusIco, statusTxt, statusKolor;
    if (komplet) { statusIco='✅'; statusTxt='Komplet zdjęć'; statusKolor='#15803d'; }
    else if (t.photo_wz_url) { statusIco='⚠️'; statusTxt='Brak raportu z licznika'; statusKolor='#a16207'; }
    else if (t.photo_paragon_url) { statusIco='⚠️'; statusTxt='Brak zdjęcia WZ'; statusKolor='#a16207'; }
    else { statusIco='📷'; statusTxt='Brak zdjęć'; statusKolor='#dc2626'; }

    var data = formatujDate(t.trip_date);
    var pojazd = t.truck_registration || '–';
    if (t.trailer_registration) pojazd += ' + ' + t.trailer_registration;
    var wz = t.wz_number || '–';

    var html = '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;">'+
      '<div style="flex:1;min-width:0;">'+
        '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:16px;font-weight:900;color:#1e293b;">📅 '+data+' · 🚛 '+pojazd+'</div>'+
        '<div style="font-size:12px;color:#64748b;margin-top:2px;">📄 WZ: '+wz+(t.naftobaza?' · 🛢️ '+t.naftobaza:'')+'</div>'+
      '</div>'+
      '</div>'+
      '<div style="font-size:13px;color:'+statusKolor+';font-weight:700;margin:8px 0;">'+statusIco+' '+statusTxt+'</div>';

    // Miniatury jeśli są
    if (t.photo_wz_url || t.photo_paragon_url) {
      html += '<div style="display:flex;gap:8px;margin:8px 0;">';
      if (t.photo_wz_url) {
        var miniWz = t.photo_wz_url.replace('/upload/', '/upload/w_120,h_120,c_fill,q_auto/');
        html += '<a href="'+t.photo_wz_url+'" target="_blank" style="display:block;width:60px;height:60px;border-radius:6px;overflow:hidden;border:2px solid #3b82f6;text-decoration:none;">'+
          '<img src="'+miniWz+'" style="width:100%;height:100%;object-fit:cover;" alt="WZ">'+
          '</a>'+
          '<div style="font-size:10px;color:#1e40af;align-self:center;">📄 WZ</div>';
      }
      if (t.photo_paragon_url) {
        var miniPar = t.photo_paragon_url.replace('/upload/', '/upload/w_120,h_120,c_fill,q_auto/');
        html += '<a href="'+t.photo_paragon_url+'" target="_blank" style="display:block;width:60px;height:60px;border-radius:6px;overflow:hidden;border:2px solid #ea580c;text-decoration:none;">'+
          '<img src="'+miniPar+'" style="width:100%;height:100%;object-fit:cover;" alt="Raport">'+
          '</a>'+
          '<div style="font-size:10px;color:#9a3412;align-self:center;">📊 Raport</div>';
      }
      html += '</div>';
    }

    // Przycisk akcji
    if (zCache) {
      html += '<div style="font-size:11px;color:#92400e;font-style:italic;text-align:center;padding:6px;background:#fef3c7;border-radius:6px;">📴 Tryb offline - ze zdjęciami można pracować po przywróceniu sieci</div>';
    } else if (komplet) {
      html += '<button class="btn-sm" style="width:100%;background:#dbeafe;color:#1e40af;font-weight:700;" onclick="CysternaPhotos.otworzModal('+t.id+')">📷 Wymień zdjęcia</button>';
    } else {
      html += '<button class="btn" style="margin-top:0;padding:10px;font-size:14px;background:linear-gradient(135deg,#ea580c,#f97316);" onclick="CysternaPhotos.otworzModal('+t.id+')">📷 Dodaj brakujące zdjęcia</button>';
    }

    div.innerHTML = html;
    return div;
  }

  // ===== POMARAŃCZOWY PASEK PRZYPOMNIENIA =====

  function odswiezPasekPrzypomnienia() {
    var bar = document.getElementById('foto-przypomnienie-bar');
    if (!bar) return;
    if (!_aktualneTrasy.length) { bar.style.display = 'none'; return; }
    // Liczymy trasy z DZIŚ bez kompletu zdjęć
    var dzis = new Date(); dzis.setHours(0,0,0,0);
    var bezZdjec = _aktualneTrasy.filter(function(t){
      if (!t.trip_date) return false;
      var d = new Date(t.trip_date); d.setHours(0,0,0,0);
      if (d.getTime() !== dzis.getTime()) return false;
      return !maKompletZdjec(t);
    }).length;
    if (bezZdjec === 0) {
      bar.style.display = 'none';
    } else {
      bar.innerHTML = '⚠️ Masz <b>'+bezZdjec+' '+(bezZdjec===1?'trasę':(bezZdjec<5?'trasy':'tras'))+' z dziś bez kompletu zdjęć</b> · Kliknij aby uzupełnić';
      bar.style.display = 'block';
    }
  }

  // ===== MODAL ROBIENIA ZDJĘĆ =====

  function otworzModal(tripId) {
    var trasa = _aktualneTrasy.find(function(t){ return t.id === tripId; });
    if (!trasa) { alert('Nie znaleziono trasy'); return; }
    _stanModala = {
      tripId: tripId,
      tripObj: trasa,
      blobWz: null,
      blobRaport: null,
      podgladWz: null,
      podgladRaport: null,
      wysylanie: false
    };
    rysujModal();
  }

  function rysujModal() {
    var s = _stanModala;
    if (!s) return;
    var t = s.tripObj;
    var modal = document.getElementById('foto-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'foto-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
    }
    var pojazd = t.truck_registration || '';
    if (t.trailer_registration) pojazd += ' + ' + t.trailer_registration;
    var dataPl = formatujDate(t.trip_date);

    var sekWz = sekcjaZdjecia('wz', '📄', 'Zdjęcie WZ', t.photo_wz_url, s.podgladWz, '#3b82f6');
    var sekRap = sekcjaZdjecia('raport', '📊', 'Raport z licznika', t.photo_paragon_url, s.podgladRaport, '#ea580c');

    var jestNoweZdj = !!(s.blobWz || s.blobRaport);
    var btnWyslij = '';
    if (jestNoweZdj) {
      btnWyslij = '<button class="btn btn-green" id="foto-btn-wyslij" onclick="CysternaPhotos.wyslijZdjecia()" '+(s.wysylanie?'disabled':'')+'>'+
        (s.wysylanie ? '⏳ Wysyłanie...' : '✓ Zapisz zdjęcia')+
        '</button>';
    }

    modal.innerHTML = '<div class="modal-box" style="max-width:500px;">'+
      '<button class="modal-close" onclick="CysternaPhotos.zamknijModal()" '+(s.wysylanie?'disabled style="opacity:.5"':'')+'>✕ Zamknij</button>'+
      '<div class="hero" style="background:linear-gradient(135deg,#7c2d12,#ea580c);">'+
        '<h2>📷 ZDJĘCIA TRASY</h2>'+
        '<p>'+dataPl+' · '+pojazd+' · WZ: '+(t.wz_number||'–')+'</p>'+
      '</div>'+
      '<div style="background:#fef3c7;border-radius:8px;padding:10px;margin-top:12px;font-size:12px;color:#854d0e;line-height:1.4;">'+
        '💡 <b>Wskazówka:</b> rób zdjęcia w jasnym świetle, dokument w całości w kadrze. Apka sama zmniejszy zdjęcie - możesz robić w pełnej rozdzielczości.'+
      '</div>'+
      sekWz +
      sekRap +
      '<div id="foto-modal-msg" style="margin-top:10px;font-size:13px;text-align:center;min-height:18px;"></div>'+
      btnWyslij+
      '<div style="height:20px;"></div>'+
      '</div>';
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  // Sekcja 1 zdjęcia w modalu (dla WZ albo raportu)
  function sekcjaZdjecia(typ, ikona, nazwa, urlIstniejacy, podglad, kolor) {
    var html = '<div class="card" style="border-left:4px solid '+kolor+';margin-top:14px;">'+
      '<div class="card-title" style="color:'+kolor+';">'+ikona+' '+nazwa+'</div>';

    if (podglad) {
      // Mamy nowe zdjęcie wybrane (jeszcze nie wysłane)
      html += '<div style="text-align:center;">'+
        '<img src="'+podglad+'" style="max-width:100%;max-height:240px;border-radius:8px;border:2px solid '+kolor+';">'+
        '<div style="margin-top:8px;display:flex;gap:8px;justify-content:center;">'+
          '<button class="btn-sm" onclick="CysternaPhotos.zrobZdjecie(\''+typ+'\')">📷 Inne zdjęcie</button>'+
          '<button class="btn-sm" style="background:#fee2e2;color:#b91c1c;" onclick="CysternaPhotos.usunWybor(\''+typ+'\')">✕ Anuluj</button>'+
        '</div>'+
        '</div>';
    } else if (urlIstniejacy) {
      // Już jest zdjęcie w bazie
      var miniUrl = urlIstniejacy.replace('/upload/', '/upload/w_400,h_400,c_fit,q_auto/');
      html += '<div style="text-align:center;">'+
        '<a href="'+urlIstniejacy+'" target="_blank">'+
          '<img src="'+miniUrl+'" style="max-width:100%;max-height:200px;border-radius:8px;border:2px solid #cbd5e1;">'+
        '</a>'+
        '<div style="margin-top:8px;font-size:12px;color:#15803d;font-weight:700;">✅ Już dodane</div>'+
        '<button class="btn-sm" style="margin-top:6px;" onclick="CysternaPhotos.zrobZdjecie(\''+typ+'\')">📷 Wymień zdjęcie</button>'+
        '</div>';
    } else {
      // Brak zdjęcia - duży przycisk do robienia
      html += '<button class="btn" style="margin-top:0;background:linear-gradient(135deg,'+kolor+'aa,'+kolor+');" onclick="CysternaPhotos.zrobZdjecie(\''+typ+'\')">📷 Zrób zdjęcie '+nazwa.toLowerCase()+'</button>';
    }
    html += '</div>';
    return html;
  }

  // Wywołanie aparatu / wyboru pliku
  function zrobZdjecie(typ) {
    if (_stanModala && _stanModala.wysylanie) return;
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment'; // wymusza tylny aparat na telefonie
    input.style.display = 'none';
    input.onchange = function(e){
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      ustawWiadomoscModala('⏳ Kompresuję zdjęcie...', '#64748b');
      kompresujZdjecie(file).then(function(blob){
        // Generuj podgląd jako data URL
        var reader = new FileReader();
        reader.onload = function(ev){
          if (typ === 'wz') {
            _stanModala.blobWz = blob;
            _stanModala.podgladWz = ev.target.result;
          } else {
            _stanModala.blobRaport = blob;
            _stanModala.podgladRaport = ev.target.result;
          }
          ustawWiadomoscModala('✅ Zdjęcie gotowe ('+Math.round(blob.size/1024)+' KB)', '#15803d');
          rysujModal();
          setTimeout(function(){ ustawWiadomoscModala('', ''); }, 2500);
        };
        reader.readAsDataURL(blob);
      }).catch(function(err){
        ustawWiadomoscModala('❌ ' + (err.message || 'Błąd kompresji'), '#b91c1c');
      });
    };
    document.body.appendChild(input);
    input.click();
    setTimeout(function(){ try { document.body.removeChild(input); } catch(e){} }, 1000);
  }

  function usunWybor(typ) {
    if (!_stanModala) return;
    if (typ === 'wz') {
      _stanModala.blobWz = null;
      _stanModala.podgladWz = null;
    } else {
      _stanModala.blobRaport = null;
      _stanModala.podgladRaport = null;
    }
    rysujModal();
  }

  function ustawWiadomoscModala(txt, kolor) {
    var el = document.getElementById('foto-modal-msg');
    if (el) {
      el.textContent = txt || '';
      el.style.color = kolor || '#64748b';
    }
  }

  function zamknijModal() {
    if (_stanModala && _stanModala.wysylanie) return;
    _stanModala = null;
    var modal = document.getElementById('foto-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
  }

  // ===== WYSYŁANIE ZDJĘĆ (Cloudinary -> backend) =====

  function wyslijZdjecia() {
    var s = _stanModala;
    if (!s || s.wysylanie) return;
    if (!s.blobWz && !s.blobRaport) {
      ustawWiadomoscModala('❌ Najpierw zrób przynajmniej jedno zdjęcie', '#b91c1c');
      return;
    }
    s.wysylanie = true;
    rysujModal();

    var promesy = [];
    var wyniki = {};
    var folder = String(s.tripId);

    if (s.blobWz) {
      ustawWiadomoscModala('⏳ Wysyłam zdjęcie WZ do chmury...', '#64748b');
      promesy.push(
        wyslijDoCloudinary(s.blobWz, folder).then(function(url){
          wyniki.photo_wz_url = url;
        })
      );
    }
    if (s.blobRaport) {
      promesy.push(
        wyslijDoCloudinary(s.blobRaport, folder).then(function(url){
          wyniki.photo_paragon_url = url;
        })
      );
    }

    Promise.all(promesy).then(function(){
      ustawWiadomoscModala('⏳ Zapisuję w bazie...', '#64748b');
      return zapiszLinkiWBazie(s.tripId, wyniki);
    }).then(function(){
      ustawWiadomoscModala('✅ Zdjęcia zapisane!', '#15803d');
      // Aktualizuj lokalnie
      var trasa = _aktualneTrasy.find(function(t){ return t.id === s.tripId; });
      if (trasa) {
        if (wyniki.photo_wz_url) trasa.photo_wz_url = wyniki.photo_wz_url;
        if (wyniki.photo_paragon_url) trasa.photo_paragon_url = wyniki.photo_paragon_url;
      }
      setTimeout(function(){
        zamknijModalSilnie();
        renderujListe(_aktualneTrasy, false);
        odswiezPasekPrzypomnienia();
      }, 1200);
    }).catch(function(err){
      console.error('[Photos] Błąd wysyłki:', err);
      s.wysylanie = false;
      ustawWiadomoscModala('❌ Błąd: ' + (err.message || 'nieznany'), '#b91c1c');
      rysujModal();
    });
  }

  function zamknijModalSilnie() {
    _stanModala = null;
    var modal = document.getElementById('foto-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
  }

  // ===== INTEGRACJA Z APKĄ =====

  function ekran() {
    return '<div class="hero">'+
        '<h2>📷 ZDJĘCIA TRAS</h2>'+
        '<p>Dodaj zdjęcia WZ i raportu z licznika do swoich tras</p>'+
      '</div>'+
      '<div id="foto-status" style="display:none;background:#dbeafe;color:#1e40af;border-radius:8px;padding:10px;margin-bottom:10px;font-size:13px;text-align:center;"></div>'+
      '<div style="display:flex;gap:8px;margin-bottom:10px;">'+
        '<button class="btn-sm" onclick="CysternaPhotos.odswiez()">🔄 Odśwież listę</button>'+
        '<span style="font-size:11px;color:#94a3b8;align-self:center;">Trasy z ostatnich '+CFG.DNI_HISTORII+' dni</span>'+
      '</div>'+
      '<div id="foto-list"></div>';
  }

  function odswiez() {
    renderujEkran();
  }

  // Po przełączeniu na zakładkę - załaduj listę
  function aktywuj() {
    if (!isLoggedIn()) {
      var cont = document.getElementById('foto-list');
      if (cont) {
        cont.innerHTML = '<div style="text-align:center;padding:30px;color:#92400e;background:#fef3c7;border-radius:10px;">'+
          '<div style="font-size:32px;margin-bottom:8px;">🔐</div>'+
          '<b>Zaloguj się PIN-em</b><br>'+
          '<span style="font-size:13px;">Aby pracować ze zdjęciami, musisz najpierw zalogować się do systemu.</span>'+
          '</div>';
      }
      return;
    }
    renderujEkran();
  }

  // PUBLIC API
  return {
    aktywuj: aktywuj,
    odswiez: odswiez,
    ekran: ekran,
    otworzModal: otworzModal,
    zamknijModal: zamknijModal,
    zrobZdjecie: zrobZdjecie,
    usunWybor: usunWybor,
    wyslijZdjecia: wyslijZdjecia,
    odswiezPasekPrzypomnienia: odswiezPasekPrzypomnienia
  };
})();
