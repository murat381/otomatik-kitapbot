require('dotenv').config();
const http = require('http');
http.createServer((req, res) => res.end('Bot 7/24 nobet basinda!')).listen(process.env.PORT || 3000);
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

// 1. API ANAHTARLARI (KENDİ BİLGİLERİNİ GİR)
// 1. API ANAHTARLARI (ARTIK GİZLİ KASADAN GELİYOR)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ------------------------------------------------------------------
// BÜYÜK HEDEF LİSTESİ (TÜM KATEGORİLER VE SİTELER)
// ------------------------------------------------------------------
const HEDEFLER = [
  { 
    tur: "Bilim", 
    url: "https://www.sciencedaily.com/news/space_time/", 
    linkSecici: ".col-md-8 .latest-head a, .col-sm-8 .latest-head a, .hero-col a", 
    linkOnEki: "https://www.sciencedaily.com" 
  },
  { 
    tur: "Tarih", 
    url: "https://www.sciencedaily.com/news/fossils_ruins/ancient_civilizations/", 
    linkSecici: ".col-md-8 .latest-head a, .col-sm-8 .latest-head a, .hero-col a", 
    linkOnEki: "https://www.sciencedaily.com" 
  },
  { 
    tur: "Ekonomi", 
    url: "https://www.sciencedaily.com/news/science_society/economics/", 
    linkSecici: ".col-md-8 .latest-head a, .col-sm-8 .latest-head a, .hero-col a", 
    linkOnEki: "https://www.sciencedaily.com" 
  }
];

// ------------------------------------------------------------------
// AŞAMA 1: MAKALEYİ İŞLE VE SUPABASE'E YAZ
// ------------------------------------------------------------------
async function makaleIsle(hedefUrl, kategoriTuru) {
  try {
    const { data } = await axios.get(hedefUrl);
    const $ = cheerio.load(data);
    
    // Mükerrer Kontrolü
    const orijinalBaslik = $('h1').text().trim() || $('h2').first().text().trim();
    if(!orijinalBaslik) return;

    const { data: varMi } = await supabase
      .from('kitaplar')
      .select('id')
      .ilike('baslik', `%${orijinalBaslik.substring(0, 10)}%`) 
      .limit(1);

    if (varMi && varMi.length > 0) return; // Zaten varsa atla

    let hamMetin = "";
    $('p').each((i, el) => { hamMetin += $(el).text() + "\n"; });

    if(hamMetin.length < 200) return; // Çok kısa veya boş sayfaları çöpe at

    const prompt = `Aşağıdaki metni temizle, havalı bir İngilizce başlık bul ve zorluk seviyesini (B1,B2,C1) belirle.
    Bu makalenin türü kesinlikle "${kategoriTuru}" olarak ayarlanmalıdır. 
    SADECE aşağıdaki JSON formatında çıktı ver, başka hiçbir kelime yazma:
    {"baslik": "...", "seviye": "...", "tur": "${kategoriTuru}", "icerik": "..."}
    Ham Metin: ${hamMetin}`;

    const result = await model.generateContent(prompt);
    let aiYaniti = result.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
    const makaleVerisi = JSON.parse(aiYaniti);

    // 📸 YENİ EKLENEN KISIM: Makalenin gerçek fotoğrafını bul!
    let gercekResim = $('meta[property="og:image"]').attr('content');
    if (!gercekResim) {
      // Eğer sitede resim yoksa, boş kalmaması için varsayılan bir resim ata
      gercekResim = "https://images.unsplash.com/photo-1462331940025-496dfbfc7564?q=80&w=600&auto=format&fit=crop"; 
    }

    const { data: kitapData, error: kitapError } = await supabase
      .from('kitaplar')
      .insert([{ 
        baslik: makaleVerisi.baslik, 
        seviye: makaleVerisi.seviye, 
        tur: makaleVerisi.tur,
        kapak_gorseli: gercekResim // Sabit linki sildik, yerine yakaladığımız resmi koyduk!
      }]).select();

    if (kitapError) throw kitapError;

    const { error: bolumError } = await supabase
      .from('kitap_bolumleri')
      .insert([{ kitap_id: kitapData[0].id, bolum_adi: "Article", bolum_sirasi: 1, icerik: makaleVerisi.icerik }]);

    if (bolumError) throw bolumError;

    console.log(`✅ [${kategoriTuru}] Veritabanına Eklendi: "${makaleVerisi.baslik}"`);

  } catch (hata) {
    // Hataları sessizce yut ki bot diğer makaleye geçerken çökmesin
  }
}

// ------------------------------------------------------------------
// AŞAMA 2: ÇOKLU VİTRİN TARAYICI (LİSTEYİ GEZ)
// ------------------------------------------------------------------
async function tumVitrinleriTara() {
  console.log("\n🌍 BÜYÜK TARAMA BAŞLIYOR! Tüm kategoriler geziliyor...");

  for (const hedef of HEDEFLER) {
    console.log(`\n🔎 Hedef: [${hedef.tur}] - Sızılıyor...`);
    
    try {
      const { data } = await axios.get(hedef.url);
      const $ = cheerio.load(data);
      let linkler = [];
      
      // Sitenin kendi özel HTML kuralına (linkSecici) göre linkleri topla
      $(hedef.linkSecici).each((i, el) => {
        if (i < 2) { // Her kategoriden en yeni 2 haberi al (toplam kota ve hız dengesi için)
          let link = $(el).attr('href');
          if (link) {
            // Eğer link tam URL değilse (örnek: /news/xyz.html), başına sitenin adını ekle
            link = link.startsWith('http') ? link : hedef.linkOnEki + link;
            linkler.push(link);
          }
        }
      });

      console.log(`📌 ${hedef.tur} için ${linkler.length} makale bulundu. Gemini'a gönderiliyor...`);
      
      for (const link of linkler) {
          await makaleIsle(link, hedef.tur); 
      }
      
    } catch (err) {
      console.log(`❌ ${hedef.tur} taranırken siteye ulaşılamadı.`);
    }
  }
  console.log("\n🏁 GÜNLÜK TARAMA BİTTİ. BOT UYKUYA GEÇİYOR!");
}

// Her 5 günde bir gece saat 03:00'te çalıştır
cron.schedule('0 3 */5 * *', () => {
    console.log("⏰ Nöbet vakti geldi! 5 günlük tarama başlıyor...");
    tumVitrinleriTara();
});

