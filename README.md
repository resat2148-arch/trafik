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
- **Büyüyen Şehir modu:** Küçük bir mahallede (4 blok) başlarsın; geçtiğin her seviyede şehre
  yeni bir bölge eklenir (çarşı, okul bayırı, şehir merkezi, iş merkezi, nehir kıyısı, sanayi,
  nehrin karşı yakası) ve trafik artar. Yeni bölgede binalar yükselerek kurulur, yeni sokaklar
  parlar. Tüm şehir baştan planlıdır: henüz kurulmamış bölgelere giden sokaklar harita dışına
  uzanır, bu yüzden bir kavşak bölgesi büyümeden önce de sonra da aynı kalır; yaptığın her ayar
  (ışıklar, şeritler, genişletmeler, yeşil dalgalar) sonraki seviyeye taşınır. Seviyeyi geçmek
  için günü hedef puanın üzerinde bitirmelisin: akıcı her yolculuk 10 puana kadar kazandırır,
  kazalar, vazgeçen ve evden çıkamayan sürücüler puan kaybettirir, hızlı ulaşan ambulans puan
  kazandırır. Hedefin %110'u ★★, %120'si ★★★ getirir; en iyi skorlar, yıldızlar ve unvan
  (Stajyer → Trafik Efsanesi) kaydedilir. Hedefe ulaşılamazsa seviye, yaptığın değişiklikler
  korunarak tekrar oynanır. 10. seviyeden sonra harita aynı kalır, trafik artmaya devam eder.
  Hedefler simülasyonla kalibre edildi: ilk seviyeler dokunulmamış ağla geçilebilir, 4.
  seviyeden itibaren ancak iyileştirilmiş bir ağ hedefe ulaşır.
- **Seviye avantajları (Büyüyen Şehir):** Geçtiğin her seviyeden sonra üç avantaj kartından birini
  seçersin; seçtiğin avantaj kariyerin boyunca geçerlidir ve bazıları birkaç kez alınabilir:
  belediye ödeneği +%20, yolculuk geliri +%25, ışık/levha/göbekli kavşak %20 ucuz, şerit ve
  genişletme %25 ucuz, işletme gideri −%30, kazalar −%25, sürücüler %25 daha sabırlı, yolculuk
  puanı +%5, yarı fiyatına çekici ve daha hızlı temizlik, bedava acil araç önceliği ve +%50
  ambulans ödülü, zirve trafiği −%8, yarı fiyatına sensörlü / Akıllı YZ ışık ve ek bakım yok,
  bedava polis. Teklifler her kariyer için sabittir (oyunu kapatıp açmak yeniden çekiliş
  yapmaz); seçmeden kapatırsan seçim bir sonraki açılışta karşına gelir.
- **Başarımlar:** 23 başarım (bronz, gümüş, altın) her iki modda da kazanılır: ilk gün, üç yıldız,
  rekor, Büyüyen Şehir'de 3./6./10. seviye, tüm kampanya şehirleri, 25 yıldız, bir kariyerde 6
  avantaj, %85+ memnuniyet, kazasız gün, kimsenin vazgeçmediği gün, son dakika kurtarışı,
  hedefin %140'ı, 5 göbekli kavşak, 5 yol genişletme, aynı anda 8 Akıllı YZ kavşağı, 3 yeşil
  dalga, polisle kilit çözme, 2.000 otobüs yolcusu, 10 çekici, 15 zamanında ambulans, 10.000
  yolculuk. Her başarım kasaya para ödülü yatırır; açıldığında ekranda rozet çıkar, gün sonu
  raporunda listelenir. Ana menü ve duraklatma menüsündeki "Başarımlar" ekranı ilerlemeyi gösterir.
- **Olaylar:** Yağmur (daha yavaş sürüş, daha uzun takip mesafesi), büyük etkinliklerin
  yarattığı ani talep, rastgele kazalar (çekici gönder ya da polis çağır), siren çalan
  ambulanslar (sürücüler kenara çekilir, istenirse sinyal önceliği), "danışman" ipuçları.

### Araçlar

| Araç | Ne yapar |
| --- | --- |
| Öncelikli yol / dur / yol ver | Ana yolu oluşturan iki kolu seç (düz ya da köşeden dönen ana yol), yan yollara DUR veya YOL VER levhası |
| Dört yönlü dur | Varış sırasına göre (FIFO) geçiş |
| Trafik ışığı | İki fazlı, öncelikli sol, ayrık fazlar; sabit süreler, sensörlü (kuyruk bitince yeşili erken bitirir, boş fazı atlar; kaydırıcı en uzun yeşil) veya Akıllı YZ (her yeşili ölçüp bir sonrakini trafiğe göre kendisi planlar) |
| Faz ayarı | Faz yeşil süreleri, tüm-kırmızı süresi, otomatik Webster zamanlama |
| Yeşil dalga | Bir caddedeki tüm ışıkları ortak döngü ve mesafeye göre ofsetle eşgüdümler; yön otomatik (yoğun yön) veya sabit. Açık kaldığı sürece yeni ışıklar katılır, süre değişikliklerine uyum sağlar |
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
- **Kavşaklar:** Geometrik çakışma bölgeleri; öncelikte üç sınıf (ana yolu izleyen > ana yoldan
  ayrılan > yan yoldan gelen); ışık (sarıda ikilem bölgesi, kırmızı ihlali),
  izinli sola dönüşte kavşak içinde bekleme, dur/yol ver boşluk kabulü (sabırsızlıkla küçülen
  kabul edilebilir boşluk), kavşağı tıkamama kuralı, döner kavşakta içerideki araç önceliği.
  Sürücüler temizleyemeyecekleri bir kesişme alanına girmez (çıkış doluysa çizgide bekler);
  yine de kavşak içinde döngüsel kilitlenme oluşursa döngüdeki bir araç yavaşça sıyrılıp geçer.
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
node --experimental-strip-types tests/headless.ts growth 4      # Büyüyen Şehir, seviye
node --experimental-strip-types tests/balance.ts maple 1 5 good  # strateji: none|tutorial|good|smart
```

`headless.ts` araç çakışması, kavşak bölgesi ihlali, kaza ve kilitlenme sayılarını raporlar;
`balance.ts` farklı oyuncu stratejileriyle günleri oynatıp yıldız/kovulma dengesini ölçer.

### Proje yapısı

```
src/core/      matematik, RNG, yol (Path) ve geometri yardımcıları
src/sim/       ağ modeli, kavşak kurucu, sinyaller, araç, rota, talep, simülasyon çekirdeği
src/world/     prosedürel şehir üretici (4 şehir şablonu) ve Büyüyen Şehir planı (growth.ts)
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
