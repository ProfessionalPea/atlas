// We check for the .default export first, and fall back to the raw import if it's not there
const gplayRaw = require('google-play-scraper');
const gplay = gplayRaw.default || gplayRaw;

(async () => {
  console.log("🚀 Launching Play Store Scanner...");
  
  const targetPackage = "com.gttec.Speed.Keyboard.Parkour.Escape";
  
  console.log(`\n🔍 Fetching metadata for: ${targetPackage}`);

  try {
    // Now the .app() method will execute perfectly
    const appData = await gplay.app({ appId: targetPackage });
    
    console.log("\n✅ Success! Here is the data Atlas found:");
    console.log(`  🎮 Title: ${appData.title}`);
    console.log(`  🏢 Developer: ${appData.developer}`);
    console.log(`  ⭐ Rating: ${appData.scoreText}`);
    console.log(`  💬 Reviews: ${appData.reviews}`);
    console.log(`  📥 Installs: ${appData.installs}`);
    console.log(`  🖼️ Icon URL: ${appData.icon}`);
    
  } catch (error) {
    console.log(`\n❌ Failed to fetch data. The app might be restricted or removed.`);
    console.error(error.message);
  }
})();