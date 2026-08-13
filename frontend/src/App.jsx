import { useEffect, useState } from "react";
import "./App.css";

function App() {
  const [stats, setStats] = useState({
    competitors: 0,
    accounts: 0,
    games: 0,
  });

  const [competitors, setCompetitors] = useState([]);

  useEffect(() => {
    fetch("http://localhost:3000/api/stats")
      .then((response) => response.json())
      .then((data) => {
        setStats(data);
      })
      .catch((error) => {
        console.error("Failed to load Atlas stats:", error);
      });
  }, []);

  useEffect(() => {
    fetch("http://localhost:3000/api/competitors")
      .then((response) => response.json())
      .then((data) => {
        setCompetitors(data);
      })
      .catch((error) => {
        console.error("Failed to load competitors:", error);
      });
  }, []);

  return (
    <div>
      <h1>Atlas</h1>

      <p>ASO Intelligence Dashboard</p>

      <p>
        <strong>Competitors:</strong> {stats.competitors}
      </p>

      <p>
        <strong>Accounts Tracked:</strong> {stats.accounts}
      </p>

      <p>
        <strong>Games Tracked:</strong> {stats.games}
      </p>

      <h2>Competitors</h2>

      {competitors.map((competitor) => (
        <div key={competitor.id}>
          <h3>{competitor.name}</h3>

          {competitor.accounts.map((account) => (
            <div key={account.id}>
              <h4>{account.publisher_name}</h4>

              {account.games.map((game) => (
                <div key={game.id}>
                  <p>
                    <strong>{game.title}</strong>
                  </p>

                  <p>
                    ⭐ {game.rating} · {game.ratings_count} ratings ·{" "}
                    {game.category}
                  </p>

                  <p>Package: {game.package_name}</p>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default App;