import { useEffect, useState } from "react";
import "./App.css";

function StatCard({ title, value }) {
  return (
    <div className="stat-card">
      <p>{title}</p>
      <h2>{value}</h2>
    </div>
  );
}

function App() {
  const [stats, setStats] = useState({ competitors: 0, accounts: 0, games: 0 });
  const [competitorTree, setCompetitorTree] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [lastScanTime, setLastScanTime] = useState("Never");

  const loadStats = () => {
    fetch("http://localhost:3000/api/stats")
      .then((res) => res.json())
      .then((data) => setStats(data))
      .catch((err) => console.error("Failed to load stats:", err));
  };

  const loadCompetitors = () => {
    fetch("http://localhost:3000/api/competitors")
      .then((res) => res.json())
      .then((data) => setCompetitorTree(data))
      .catch((err) => console.error("Failed to load competitors:", err));
  };

  useEffect(() => {
    loadStats();
    loadCompetitors();
  }, []);

  const handleRunScan = async () => {
    setIsScanning(true);
    try {
      const res = await fetch("http://localhost:3000/api/scan", { method: "POST" });
      const data = await res.json();
      if (data.status === "success") {
        setLastScanTime(new Date().toLocaleTimeString());
        loadStats(); 
        loadCompetitors(); // Refresh the list after scanning!
      }
    } catch (err) {
      console.error("Scan failed:", err);
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Atlas</h1>
          <p>ASO Intelligence Dashboard</p>
        </div>
        <button onClick={handleRunScan} disabled={isScanning}>
          {isScanning ? "Scanning..." : "Run Scan"}
        </button>
      </header>

      <section className="stats-grid">
        <StatCard title="Last Scan" value={lastScanTime} />
        <StatCard title="Competitors" value={stats.competitors} />
        <StatCard title="Accounts Tracked" value={stats.accounts} />
        <StatCard title="Games Tracked" value={stats.games} />
      </section>

      <section className="competitor-section">
        <h2>Competitor Directory</h2>
        <input type="text" placeholder="Search for a competitor..." />

        {/* THIS IS THE NEW PART: Rendering the Tree */}
        <div className="competitor-list">
          {competitorTree.map((comp) => (
            <div key={comp.id} className="competitor-card">
              <h3>🏢 {comp.name} <span className="badge">{comp.country}</span></h3>

              {comp.accounts && comp.accounts.map((acc) => (
                <div key={acc.id} className="account-card">
                  <h4>📁 {acc.publisher_name} <span className="status-badge">{acc.status}</span></h4>

                  <ul className="game-list">
                    {acc.games && acc.games.map((game) => (
                      <li key={game.id}>
                        🎮 <strong>{game.title}</strong> 
                        <br />
                        <small className="package-text">{game.package_name}</small>
                        <br />
                        <small>⭐ {game.rating} ({game.ratings_count} reviews)</small>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default App;