# Gridlock City: Trafik Mühendisi

> **EN:** A 3D (fixed-angle, isometric-style) traffic simulation game for the web / CrazyGames.
> You are the traffic engineer of a living city that gets more congested every day. Retime
> signals, build roundabouts, restripe lanes and clear accidents to keep citizens happy.
> Every car is an individual agent with its own route, temperament and driving style.

Hazır ama her gün biraz daha tıkanan bir şehrin trafik mühendisisin. Şehir büyüdükçe talep
artıyor, sabah ve akşam zirveleri sertleşiyor, yağmur, kazalar, etkinlikler ve ambulanslar
işini zorlaştırıyor. Kavşakları ve yolları yeniden düzenleyerek vatandaşları 22:00'ye kadar
mutlu tutmalısın — memnuniyet sıfıra düşerse kovulursun.

## Oynanış

- **Günler:** Her gün 06:00–22:00 arası (~8 dakika). Gün başında talep tahmini, yeni binalar ve
  açılan araçlar gösterilir; gün sonunda yıldız, istatistik ve bütçe raporu gelir.
- **Memnuniyet:** Her yolculuk serbest akış süresine göre puanlanır. Uzun bekleyen, öfkelenen,
  evden çıkamayan ya da yolculuğu bırakan sürücüler memnuniyeti düşürür.
- **Bütçe:** Günlük hibe (memnuniyete bağlı), otobüs bilet gelirleri ve her başarılı
  yolculuktan gelen yol ücreti; ışıklar, akıllı sinyaller ve göbekli kavşakların bakım gideri
  vardır. Her müdahalenin bir maliyeti var.
- **Şehirler:** Akçaağaç Vadisi (eğitim, araçlar gün gün açılır) → Nehirkent (köprüler) →
  Merkez Tepeler (tek yönler, bulvar) → Metropol Körfezi. Her şehir bittiğinde sıradaki açılır,
  ardından sonsuz mod.
- **Olaylar:** Yağmur (daha yavaş sürüş, daha uzun takip mesafesi), büyük etkinliklerin
  yarattığı ani talep, rastgele kazalar (çekici gönder ya da polis çağır), siren çalan
  ambulanslar (sürücüler kenara çekilir, istenirse sinyal önceliği), "danışman" ipuçları.

### Araçlar

| Araç | Ne yapar |
| --- | --- |
| Öncelikli yol / dur / yol ver | Ana yolu seç, yan yollara DUR veya YOL VER levhası |
| Dört yönlü dur | Varış sırasına göre (FIFO) geçiş |
| Trafik ışığı | İki fazlı, öncelikli sol, ayrık fazlar; sabit / tetiklemeli / akıllı (max-pressure) mod |
| Faz ayarı | Faz yeşil süreleri, tüm-kırmızı süresi, otomatik Webster zamanlama, yeşil dalga |
| Kırmızıda sağa dönüş, sarı kutu | Kavşak tıkamayı önler |
| Göbekli kavşak | Döner kavşak (girişte yol ver, ada, ayırıcı adalar) |
| Şerit okları | Her şeridin dönüş izinleri (ayrı sol/sağ dönüş şeritleri) |
| Şerit ekle / tek yön | Yolu yeniden çizgile; yol doluysa şerit başına $4.000'a genişletilir (köprüler, kenarında bina olan yollar ve çok kısa yollar genişletilemez; bağlantı kopacaksa reddedilir) |
| Hız sınırı, otobüs şeridi | Yol bazında |
| Politikalar | Esnek çalışma saatleri, ücretsiz toplu taşıma, trafik güvenliği kampanyası, acil araç sinyal önceliği |
| Çekici / polis | Kazaları ve kilitlenmiş araçları temizler |

## Trafik yapay zekası

- **Takip modeli:** IDM (Intelligent Driver Model) + duran engellere ve stop çizgilerine
  kinematik frenleme profili; kalkışta reaksiyon gecikmesi (gerçekçi kalkış dalgaları,
  ~1600 araç/saat/şerit doygun akım).
- **Şerit değiştirme:** MOBIL; rota için zorunlu şerit seçimi, fermuar usulü birleşmede
  işbirliği (öndeki boşluğu açma), sağ şerit eğilimi, bir sonraki kavşak için ön konumlanma.
- **Kavşaklar:** Geometrik çakışma bölgeleri; ışık (sarıda ikilem bölgesi, kırmızı ihlali),
  izinli sola dönüşte kavşak içinde bekleme, dur/yol ver boşluk kabulü (sabırsızlıkla küçülen
  kabul edilebilir boşluk), kavşağı tıkamama kuralı, döner kavşakta içerideki araç önceliği.
- **Rota:** Canlı seyahat süreleriyle Dijkstra, ana arter tercihi, navigasyon uygulaması
  kullanan sürücülerin yeniden rotalanması, kaçırılan dönüşte yeni rota.
- **Talep:** Saatlik profiller (ev→iş, iş→ev, alışveriş, iş seyahati, transit, şehir dışı),
  çekim modeline göre hedef seçimi, otoparklar, şehir girişleri, otobüs hatları.
- **Kişilik:** Her sürücünün takip mesafesi, reaksiyon süresi, agresifliği, kırmızıda geçme ve
  kavşak tıkama eğilimi farklı; bekledikçe sinirlenir, korna çalar, sonunda yolculuğu bırakır.

## Kontroller

- **Fare:** sürükle = kaydır, tekerlek = yakınlaş, sağ tık sürükle = döndür, tıkla = seç
- **Dokunmatik:** tek parmak kaydır, iki parmak yakınlaş/döndür
- **Klavye:** WASD/oklar kaydır, Q/E döndür, Z/X yakınlaş, Boşluk duraklat, 1-3 hız,
  T trafik katmanı, L kavşak notları, Esc menü

## Geliştirme

Gereksinim: Node.js 22+

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tip denetimi + üretim derlemesi -> dist/
npm run preview    # dist/ klasörünü yerelde sun
npm run simtest    # başsız (headless) simülasyon testi
```

Ek simülasyon testleri (`node --experimental-strip-types` ile):

```bash
node --experimental-strip-types tests/headless.ts riverside 3   # şehir, gün
node --experimental-strip-types tests/balance.ts maple 1 5 good  # strateji: none|tutorial|good|smart
```

`headless.ts` araç çakışması, kavşak bölgesi ihlali, kaza ve kilitlenme sayılarını raporlar;
`balance.ts` farklı oyuncu stratejileriyle günleri oynatıp yıldız/kovulma dengesini ölçer.

### Proje yapısı

```
src/core/      matematik, RNG, yol (Path) ve geometri yardımcıları
src/sim/       ağ modeli, kavşak kurucu, sinyaller, araç, rota, talep, simülasyon çekirdeği
src/world/     prosedürel şehir üretici (4 şehir şablonu)
src/game/      oyun döngüsü, ekonomi, günler, kayıt, yerelleştirme (EN/TR)
src/render/    three.js sahne: dünya, araçlar, yayalar, ışık/gece-gündüz/yağmur, kamera, katmanlar
src/ui/        HUD, paneller, menüler, eğitim
src/audio/     prosedürel Web Audio sesleri ve müzik
src/platform/  CrazyGames SDK v3 sarmalayıcısı
tests/         başsız simülasyon ve denge testleri
```

## CrazyGames'e yükleme

1. `npm run build`
2. `dist/` klasörünün **içeriğini** zip'leyip CrazyGames geliştirici portalına HTML5 oyun olarak
   yükle (yollar göreli: `base: './'`, harici kaynak yok, yazı tipleri pakette).
3. SDK v3 çalışma zamanında yüklenir; SDK yoksa (yerel/başka site) oyun bağımsız modda çalışır.
   - `loadingStart/Stop`, `gameplayStart/Stop`, 2+ yıldızda `happytime`
   - Günler arasında `midgame` reklamı (en az 3 dakika arayla)
   - Ödüllü reklam: günlük hibeyi ikiye katla, kovulunca ikinci şans
   - İlerleme kaydı SDK data modülünde (yoksa `localStorage`)
   - Reklamlar yalnızca gün aralarında gösterilir, reklam sırasında ses kapanır;
     platformun sessize alma ayarına uyulur

Sürüm: three.js 0.186, Vite 8, TypeScript 5.9.
