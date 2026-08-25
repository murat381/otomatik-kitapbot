require('dotenv').config();
const http = require('http');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

// Keep-alive server to prevent the hosting instance from sleeping
http.createServer((req, res) => res.end('Service is actively running.')).listen(process.env.PORT || 3000);

// ==========================================
// 1. CONFIGURATION & CONNECTIONS
// ==========================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ==========================================
// 2. TARGET SOURCES (SCRAPING POOL)
// ==========================================
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

// ==========================================
// 3. CORE PROCESSING PIPELINE
// ==========================================

/**
 * Fetches the article, processes it via AI for formatting, and inserts it into the database.
 */
async function makaleIsle(hedefUrl, kategoriTuru) {
  try {
    const { data } = await axios.get(hedefUrl);
    const $ = cheerio.load(data);
    
    // Extract the primary title for duplicate verification
    const orijinalBaslik = $('h1').text().trim() || $('h2').first().text().trim();
    if (!orijinalBaslik) return;

    // Check for existing records to prevent duplicates
    const { data: varMi } = await supabase
      .from('kitaplar')
      .select('id')
      .ilike('baslik', `%${orijinalBaslik.substring(0, 10)}%`) 
      .limit(1);

    if (varMi && varMi.length > 0) return; // Skip if already exists

    // Aggregate raw text content
    let hamMetin = "";
    $('p').each((i, el) => { hamMetin += $(el).text() + "\n"; });

    if (hamMetin.length < 200) return; // Discard pages with insufficient content

    // Construct the prompt for content structuring and evaluation
    const prompt = `Clean the following text, generate an engaging English title, and determine its difficulty level (B1, B2, C1).
    The genre of this article must be strictly set to "${kategoriTuru}". 
    Output ONLY in the following JSON format, without any markdown formatting or additional text:
    {"baslik": "...", "seviye": "...", "tur": "${kategoriTuru}", "icerik": "..."}
    Source Text: ${hamMetin}`;

    const result = await model.generateContent(prompt);
    let aiYaniti = result.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
    const makaleVerisi = JSON.parse(aiYaniti);

    // Extract Open Graph meta image for thumbnail utilization
    let gercekResim = $('meta[property="og:image"]').attr('content');
    if (!gercekResim) {
      // Fallback mechanism if no featured image is found
      gercekResim = "https://images.unsplash.com/photo-1462331940025-496dfbfc7564?q=80&w=600&auto=format&fit=crop"; 
    }

    // Insert metadata into the primary table
    const { data: kitapData, error: kitapError } = await supabase
      .from('kitaplar')
      .insert([{ 
        baslik: makaleVerisi.baslik, 
        seviye: makaleVerisi.seviye, 
        tur: makaleVerisi.tur,
        kapak_gorseli: gercekResim 
      }]).select();

    if (kitapError) throw kitapError;

    // Insert the processed content into the relational chapters table
    const { error: bolumError } = await supabase
      .from('kitap_bolumleri')
      .insert([{ 
        kitap_id: kitapData[0].id, 
        bolum_adi: "Article", 
        bolum_sirasi: 1, 
        icerik: makaleVerisi.icerik 
      }]);

    if (bolumError) throw bolumError;

    console.log(`[SUCCESS] Database Insertion: [${kategoriTuru}] "${makaleVerisi.baslik}"`);

  } catch (hata) {
    // Fail silently to ensure the continuity of the scraping loop
  }
}

// ==========================================
// 4. BATCH SCRAPING INITIALIZER
// ==========================================

async function tumVitrinleriTara() {
  console.log("\n[INFO] Initializing batch scraping cycle across all target categories...");

  for (const hedef of HEDEFLER) {
    console.log(`\n[INFO] Scanning target category: [${hedef.tur}]`);
    
    try {
      const { data } = await axios.get(hedef.url);
      const $ = cheerio.load(data);
      let linkler = [];
      
      // Parse DOM to extract article endpoints using target-specific selectors
      $(hedef.linkSecici).each((i, el) => {
        if (i < 2) { // Limit to 2 recent articles per cycle for rate management
          let link = $(el).attr('href');
          if (link) {
            // Normalize relative paths to absolute URLs
            link = link.startsWith('http') ? link : hedef.linkOnEki + link;
            linkler.push(link);
          }
        }
      });

      console.log(`[INFO] Located ${linkler.length} endpoints for [${hedef.tur}]. Forwarding to AI processor...`);
      
      for (const link of linkler) {
          await makaleIsle(link, hedef.tur); 
      }
      
    } catch (err) {
      console.error(`[ERROR] Connection failed or target unreachable: [${hedef.tur}]`);
    }
  }
  console.log("\n[INFO] Scraping cycle completed successfully. System is now idle.");
}

// ==========================================
// 5. CRON JOB SCHEDULER
// ==========================================

// Executes the routine every 5 days at 03:00 AM server time
cron.schedule('0 3 */5 * *', () => {
    console.log("[INFO] Scheduled cron event triggered. Commencing data synchronization...");
    tumVitrinleriTara();
});
