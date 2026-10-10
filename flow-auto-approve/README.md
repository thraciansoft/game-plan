# Flow Oto-Onay (Chrome eklentisi)

Google Flow her toplu üretimden sonra (ör. 24 görselde bir) sohbette
"devam edeyim mi?" diye onay istiyor. Bu eklenti o soruyu algılar ve onayı sizin
yerinize verir:

- **Butona tıklar.** Sorunun yanında "Devam et", "Onayla", "Continue" gibi bir
  buton varsa ona tıklar.
- **Sohbete yazar.** Buton yoksa sohbet kutusuna `Evet, devam et` yazıp gönderir.

Varsayılan mod **İkisi de**'dir: önce buton aranır, buton yoksa mesaj yazılır.

## Kurulum

1. Bu klasörü (`flow-auto-approve`) bilgisayarınıza indirin. Repoyu ZIP olarak
   indirip açabilirsiniz.
2. Chrome'da `chrome://extensions` sayfasını açın.
3. Sağ üstten **Geliştirici modu**'nu açın.
4. **Paketlenmemiş öğe yükle**'ye tıklayıp `flow-auto-approve` klasörünü seçin.
5. Google Flow sekmesi açıksa sayfayı yenileyin (F5).

Araç çubuğundaki ikonun üzerindeki sayı, şimdiye kadar verilen otomatik onay
sayısını gösterir. `OFF` kapalı, `MAX` ise limitin dolduğu anlamına gelir.

## İlk kullanım: onay butonunu öğretin

Flow'un onay ekranındaki metin farklı olabilir. Eklenti ilk seferde çalışmazsa:

1. Flow onay istediğinde eklenti ikonuna tıklayın.
2. **🎯 Onay butonunu sayfada seç**'e basın.
3. Sayfada onay/devam butonuna bir kez tıklayın. Bu tıklama Flow'a gitmez,
   yalnızca butonun metni kaydedilir.
4. Ardından butona kendiniz bir kez tıklayın. Sonraki her 24'lük partide eklenti
   bu butona kendisi tıklayacak.

Ekranda "çevresinde tetik ifadesi yok" uyarısı çıkarsa uyarıdaki sorunun bir
parçasını **Metinler ve gelişmiş ayarlar → Tetik ifadeleri** listesine ekleyin.
Örneğin `devam etmemi ister misiniz` ekleyebilirsiniz. Ya da
**Butona tıklamak için yakınında tetik metni gerekli** seçeneğini kapatın.

Onay butonu yoksa ve Flow sizden yazılı cevap bekliyorsa mod olarak
**Sohbete yaz**'ı seçin. Gerekirse cevabı da değiştirin.

## Ayarlar

| Ayar | Açıklama |
|---|---|
| Bekleme (ms) | Soru göründükten sonra işlem yapmadan önce beklenen süre. Mesajın tamamen yüklenmesi için zaman tanır. |
| Soğuma (ms) | İki otomatik onay arasındaki en kısa süre. |
| Maks. onay | Bu kadar onaydan sonra eklenti durur (`0` = sınırsız). Her onay yeni bir parti, yani kredi demektir. Sayaç popup'tan sıfırlanır. |
| Onay butonu metinleri | Tıklanabilecek butonların metinleri. Tam kelime olarak eşleşir; büyük/küçük harf ve Türkçe karakter farkı önemsizdir. |
| Tetik ifadeleri | Sorunun içinde geçen metinler, ör. `devam edeyim mi`. Sohbete yazma modu yalnızca bunlardan biri **yeni gelen** bir mesajda görünürse çalışır. |
| Asla tıklanmayacak metinler | `Durdur`, `İptal`, `Hayır`, `Stop`… Bu metinleri içeren butonlara asla tıklanmaz. |
| CSS seçiciler | Metinle eşleştirme yetmezse onay butonu, sohbet kutusu ve gönder butonu için doğrudan CSS seçici girilebilir. |

## Güvenlik önlemleri

- Bir buton ancak yanında (ekranda en fazla ~250 px uzakta) bir tetik ifadesi
  varsa tıklanır. Sayfanın başka bir yerindeki "Continue" butonlarına dokunulmaz.
- Sohbete yazma yalnızca sayfa açıldıktan **sonra** gelen mesajlara tepki verir.
  Eski sohbet geçmişine cevap yazılmaz.
- Eklentinin kendi gönderdiği mesaj tetik sayılmaz, bu yüzden döngüye girmez.
- Eklenti yalnızca `https://labs.google/*` sayfalarında çalışır. Hiçbir veri
  dışarı gönderilmez, ayarlar tarayıcınızda (`chrome.storage.local`) kalır.

## Sorun giderme

- **Hiçbir şey olmuyor:** Popup'taki uyarı kutusuna bakın. Eklenti neyi
  bulduğunu veya bulamadığını orada yazar. Ayrıca **Konsola ayrıntılı kayıt yaz**'ı
  açıp sayfada F12 → Console'da `[Flow Oto-Onay]` satırlarına bakabilirsiniz.
- **Eklentiyi güncelledim, çalışmıyor:** Flow sekmesini yenileyin.
- **Tıklıyor ama Flow tepki vermiyor:** Bazı arayüzler yalnızca gerçek fare
  tıklamalarını kabul eder. Bu durumda onay penceresinin HTML'ini
  (sağ tık → İncele) paylaşın, eklenti ona göre uyarlanabilir.

Not: Otomasyon, Google'ın kullanım koşullarına veya kota kurallarına takılabilir.
Kredi harcamasını kontrol altında tutmak için **Maks. onay** ayarını kullanın.

## Test

Sahte bir Flow sayfası üzerinde (`test/mock-flow.html`) eklentiyi gerçek
Chromium'a yükleyip uçtan uca test eder. Buton, diyalog, textarea ve
contenteditable sohbet senaryolarının yanı sıra limit, kapalı mod ve öğretme
modunu da kapsar:

```bash
npm i -g playwright   # yoksa
node test/e2e.mjs
```
