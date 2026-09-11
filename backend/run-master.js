const { scanCompetitor } = require('./GoogleAdsScanner');

(async () => {
  // We ask it to search Playmax, look for Pakistan, and scan a max of 30 ads!
  const packages = await scanCompetitor("Playmax", "Pakistan", 30);
  
  console.log("\n🚀 FINAL OUTPUT DELIVERED BACK TO THE CALLER:");
  console.log(packages);
})();