module.exports = {
  apps: [
    {
      name: "atlas-backend",
      cwd: "./backend",
      script: "server.js",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: "800M",
      env: {
        NODE_ENV: "development",
        PORT: 3000
      }
    }
  ]
};
