# Flow Oto-Onay (Chrome eklentisi)

Promptlarınızı Google Flow'un sohbetine toplu gönderir. Flow'un her partiden
sonra sorduğu onayları kendisi verir. Bütün görseller bitince de görselleri
prompt sırasına göre `001`, `002`… diye adlandırtır.

## Nasıl çalışır?

Örnek: 120 prompt girdiniz.

1. Eklenti sohbete numaralı 120 promptu tek mesajda gönderir ve görsellerin
   **20'şer** oluşturulmasını ister.
2. Flow her 20 görselde bir "Devam edeyim mi?" diye sorarsa eklenti sohbete
   **Devam et** yazar. Flow sormadan partileri kendisi sürdürürse eklenti
   karışmaz. Flow "120 sahnenin tamamı oluşturuldu" dediğinde sıradaki adıma
   geçer.
   Flow bir partide "Başarısız / istek limiti (THROTTLED)" derse eklenti
   kotanın toparlanması için bekler (varsayılan 45 sn; panelde geri sayım görünür). Sonra "Devam et" yerine
   **"Başarısız olan ya da atlanan görselleri yeniden dene, sonra kaldığın
   yerden devam et"** yazar.
3. Üretim bitince eklenti bir **kontrol** mesajı gönderir: Flow 1–120
   arasındaki her promptu kontrol eder ve görseli olmayan ya da başarısız
   olanları yeniden üretir.
4. Ardından eklenti şu isimlendirme mesajını gönderir: *"1. prompttan oluşan
   görselin adı 001, 2. prompttan oluşanın adı 002 olsun … son görsel
   120"*.
5. Flow her 20 görselde bir "Kalanları isimlendireyim mi?" diye sorar. Eklenti
   **Evet, devam et** yazar.
6. Son olarak bir **ad kontrolü** mesajı gider: Flow bütün görsellerin adlarını
   gözden geçirir ve `001` biçiminde olmayanları düzeltir.
7. **Video (isteğe bağlı):** Paneldeki **Görseller bitince video** anahtarı
   açıksa, eklenti Flow'a seçtiğiniz video motoruyla (Omni 1.1 Flash,
   Veo 3.1 - Lite / Fast / Quality) her görselden, aynı numaralı promptu
   kullanarak görselden videoya video ürettirir. Videolar `001_v`, `002_v`…
   diye adlandırılır. Partiler varsayılan olarak 10'ar videodur. Flow her
   partide sorarsa eklenti yine **Devam et** yazar. Videolar görsellerden çok
   daha fazla kredi harcar.
8. **İndirme:** Paneldeki **Bitince indir** anahtarı açıksa eklenti en sonda Flow galerisini baştan sona kaydırır. Adı 001…120 olan her
   görseli `İndirilenler/Flow/<proje adı>/001.jpg` biçiminde bilgisayarınıza
   indirir.
9. Bitince panelde **Tamamlandı** yazar. Kaç görselin indiği ve bulunamayan
   numaralar panel kaydında görünür.

İstediğiniz an paneldeki **⬇ Görselleri indir** ile galerideki görselleri
adlarıyla indirebilirsiniz. Flow'un kendi indirme düğmesini kullanırsanız
eklenti, Flow'un dosya adına eklediği tarihi siler:
`001_20261011093000.jpg` → `001.jpg`.

Chrome ilk indirmede birden fazla dosya indirmeye izin isteyebilir; izin verin.

Kontrol adımlarını paneldeki onay kutularından kapatabilirsiniz. Mesaj
metinlerini Gelişmiş ayarlardan değiştirebilirsiniz.

Eklenti yalnızca sohbete yazar, sayfadaki hiçbir butona tıklamaz. Tek istisna,
yazdığı mesajı göndermek için sohbet kutusunun gönder butonudur.

## Kurulum

1. Bu klasörü (`flow-auto-approve`) bilgisayarınıza indirin. Repoyu ZIP olarak
   indirip açabilirsiniz.
2. Chrome'da `chrome://extensions` sayfasını açın.
3. Sağ üstten **Geliştirici modu**'nu açın.
4. **Paketlenmemiş öğe yükle**'ye tıklayıp `flow-auto-approve` klasörünü seçin.
   Eski sürüm yüklüyse önce onu kaldırın veya ↻ ile yenileyin.
5. Flow sekmesini yenilemeniz gerekmez. Panel ilk kullanımda eklentiyi açık
   Flow sekmesine kendisi yükler.

## Kullanım

1. Google Flow'da (`flow.google.com`) projenizi açın.
2. Araç çubuğundaki eklenti ikonuna tıklayın. Sağda **yan panel** açılır ve
   sayfada çalışırken açık kalır.
3. Promptları kutuya yapıştırın. İsterseniz bir `.txt` dosyasını
   **📄 .txt yükle** ile de açabilirsiniz. **Ayırma: Otomatik**
   şu biçimleri tanır:

   - **Zaman kodlu:** Her prompt `[00:00 - 00:01] -> …` gibi bir zaman koduyla
     başlar. Promptlar ayrı satırlarda ya da aynı satırda olabilir.
   - **Boş satırla ayrılmış:** Bir prompt birden fazla satır olabilir.
   - **Her satır bir prompt.**

   Kutunun altında kaç prompt algılandığını, ilk iki ve son promptu görürsünüz.
   **Başlatmadan önce bu sayıyı kontrol edin.** Yanlışsa **Ayırma** menüsünden
   biçimi elle seçin.
4. **Parti büyüklüğü** (20), **İsim öneki** (varsayılan boş) ve **Basamak** (3)
   değerlerini kontrol edin. Boş önek + 3 basamak `001…144` verir; önek `gorsel`
   yazarsanız `gorsel001…` olur.
5. **▶ Başlat**'a basın. İlerlemeyi ve yapılan her adımı panelde görürsünüz.

| Buton | İşlevi |
|---|---|
| ⏸ Duraklat | Eklenti cevap yazmayı bırakır. |
| ⏵ Sürdür | Kaldığı yerden devam eder. Sayfa yenilendiyse de bununla devam edilir. |
| ⏭ Sonraki adım | Mevcut adımı bitmiş sayar ve sıradaki mesajı gönderir. Flow işi bitirdiği hâlde eklenti beklemeye devam ediyorsa kullanın. |
| ■ Durdur | Görevi sonlandırır. |

**Gelişmiş ayarlar → Gönderilecek mesajları önizle** ile Flow'a gidecek
mesajları göndermeden önce görebilirsiniz.

## Eklenti Flow'un sorduğunu nasıl anlıyor?

- **Soru algılama:** Flow'un son mesajında "devam edeyim mi",
  "isimlendireyim mi", "continue?" gibi bir ifade varsa ve mesaj 3 saniyedir
  değişmiyorsa eklenti cevap yazar.
- **Tur sonu kuralı:** Flow soru sormadan durursa eklenti sayfanın tamamen
  sakinleşmesini bekler (varsayılan 30 sn). Sonra Flow'un son "bitti"
  cümlesine bakar:
  - Cümlede "tamamı", "tüm", "hepsi", "tamamlandı" gibi bir kelime varsa ve
    cümledeki sayı prompt sayısıyla eşleşiyorsa adım bitmiş sayılır ve
    sonrakine geçilir. Örnek: "Listedeki 120 sahnenin tamamı oluşturuldu."
  - Sayı eşleşmiyorsa Flow erken durmuş demektir ve eklenti **Devam et** yazar.
    Örnek: 120 prompt için "84 sahnenin tamamı".
  - Hiç "bitti" cümlesi yoksa da **Devam et** yazar.
- **Flow meşgulken:** Sohbet kutusunun yanında "Durdur/Stop" butonu
  görünüyorsa Flow hâlâ çalışıyor demektir. Eklenti bu sırada bir şey yazmaz.
- **Güvenlik sınırı:** Eklenti bir adımda beklenenden 5 kez fazla
  **Devam et** yazmak zorunda kalırsa görevi duraklatır ve panelde uyarır.
  Böylece sonsuz döngü ve gereksiz kredi harcaması olmaz.

Görev yokken de (ör. Flow'a kendiniz yazdığınızda) eklenti "Devam edeyim mi?"
sorularına **Devam et** yazar. Bunu paneldeki onay kutusundan kapatabilirsiniz.

## Gelişmiş ayarlar

| Ayar | Açıklama |
|---|---|
| Onay cevabı / İsimlendirme cevabı | Sohbete yazılan cevaplar (`Devam et`, `Evet, devam et`). |
| Mesaj başına prompt | `0` ise bütün promptlar tek mesajda gider. Flow uzun mesajı kabul etmezse `20` yapın: her 20 prompt ayrı mesajla gönderilir. |
| Soru bekleme | Soru göründükten sonra cevap yazmadan önce beklenen süre. |
| Tur bitti sayma | Tur sonu kuralı için sayfanın ne kadar süre sakin kalması gerektiği. Flow partiler arasında uzun süre hiçbir şey göstermiyorsa artırın. |
| Mesaj şablonları | Flow'a giden üretim ve isimlendirme mesajlarının metni. Yer tutucular: `{adet}` `{parti}` `{baslangic}` `{bitis}` `{toplam}` `{onek}` `{promptlar}`. |
| Tetik ifadeleri | Flow'un sorusunda geçen ve "onay bekliyorum" anlamına gelen metinler. |
| Bitti ifadeleri | Flow'un "hepsi bitti" cümlesindeki kelimeler. O cümledeki sayı prompt sayısıyla eşleşmelidir. |
| CSS seçiciler | Eklenti sohbet kutusunu veya gönder butonunu bulamazsa doğrudan seçici girin. |

## Sorun giderme

**Tanı raporu:** Panelin altındaki **Tanı raporu** bölümü, eklentinin Flow'da
ne gördüğünü kaydeder. Raporu Flow "devam edeyim mi?" diye sorarken alın.

- **📋 Kısa rapor:** Panoya kopyalanır. Şunları içerir: bulunan sohbet kutusu,
  gönder ve durdur butonları, sohbet kutusunun yanındaki butonlar ve
  eklentinin okuduğu son mesaj metni.
- **⬇ Tam rapor:** Kısa raporun yanında sayfanın HTML kopyasını da içeren bir
  `.json` dosyası indirir. Betikler, görsel/video linkleri ve diğer bağlantılar
  çıkarılır, ama sohbet metinleri ve promptlar içinde kalır. Göndermeden önce
  içine göz atın.

  Bu repo herkese açık olduğu için raporu repoya yüklemeyin. Geliştirici tam
  raporu `node test/replay.mjs rapor.json` ile kendi tarayıcısında yeniden
  açıp eklentinin aynı öğeleri bulup bulmadığını kontrol edebilir.

Diğer sorunlar:

- **"Etkin sekme Google Flow değil":** Panel o anda öndeki sekmeyle konuşur.
  `flow.google.com` sekmesine geçip tekrar deneyin. Sorun sürerse o sayfayı
  yenileyin. Eklenti `flow.google.com` ve eski adres `labs.google` üzerinde
  çalışır.
- **"Sohbet kutusu bulunamadı":** Gelişmiş ayarlara sohbet kutusunun CSS
  seçicisini girin. Seçiciyi Flow'da kutuya sağ tık → İncele ile bulabilirsiniz.
- **Mesaj yazılıyor ama gitmiyor:** Gönder butonunun CSS seçicisini girin.
- **Flow bitirdi ama eklenti bekliyor:** **⏭ Sonraki adım**'a basın veya
  Flow'un soru cümlesini tetik ifadelerine ekleyin.
- Ayrıntılı kayıt için **Konsola ayrıntılı kayıt yaz**'ı açın. Sonra Flow
  sayfasında F12 → Console'da `[Flow Oto-Onay]` satırlarına bakın.

Not: Otomasyon, Google'ın kullanım koşullarına veya kota kurallarına takılabilir.
Flow çok hızlı istek gönderildiğinde de hata verebilir.

## Test

`test/mock-flow.html`, Flow'un sohbet ajanını taklit eden bir sayfadır: her 20
görselde durup sorar, sonra görselleri yeniden adlandırır. Test, eklentiyi
gerçek Chromium'a yükleyip bu sayfa üzerinde tam görevler çalıştırır. Şunları
kapsar:

- textarea ve zengin metin editörü
- durdur butonu olan ve olmayan sohbet kutusu
- tanınmayan soru cümleleri
- mesaj başına 20 prompt
- görev dışı otomatik cevap
- yan panelden başlatma, duraklatma ve sürdürme

```bash
npm i -g playwright   # yoksa
node test/e2e.mjs
```
