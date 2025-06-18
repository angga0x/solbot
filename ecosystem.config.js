module.exports = {
  apps: [
    {
      name: 'solana-sniper-bot', // Application name that will appear in PM2
      script: 'dist/main.js', // Path to the script PM2 will run (after `npm run build`)
      // script: 'npm', // Alternative: if you want to run via npm script
      // args: 'start', // Alternative: arguments for npm script if using 'npm' as script

      // Options reference: https://pm2.keymetrics.io/docs/usage/application-declaration/
      instances: 1, // Run a single instance of the application
      autorestart: true, // Restart the application if it crashes
      watch: false, // Do not watch for file changes (can be enabled for dev, e.g., watch: ['./src'])
      max_memory_restart: '1G', // Restart if it exceeds 1GB RAM
      // cron_restart: '0 0 * * *', // Optional: cron pattern to restart app (e.g., daily at midnight)
      
      // Logging
      out_file: './logs/pm2-out.log', // Path to a file to save stdout
      error_file: './logs/pm2-error.log', // Path to a file to save stderr
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z', // Date format for logs
      merge_logs: true, // Merge logs from all instances (if more than 1)

      // Environment variables specific to this PM2 process
      // These can override or supplement what's in your .env file if needed,
      // but typically, you'd rely on the .env file loaded by your application.
      // env: {
      //   NODE_ENV: 'development',
      // },
      env_production: {
        NODE_ENV: 'production',
        // Add any production-specific environment variables here
        // e.g., different RPC endpoints or API keys for production
      },

      // Delay between restarts (in ms)
      restart_delay: 5000, // 5 seconds

      // Number of unstable restarts (less than 1sec interval) before PM2 stops restarting
      max_restarts: 5, 
    },
  ],

  // Optional: Deploy configuration (if you use PM2 for deployment)
  // deploy: {
  //   production: {
  //     user: 'node',
  //     host: '212.83.163.1',
  //     ref: 'origin/master',
  //     repo: 'git@github.com:repo.git',
  //     path: '/var/www/production',
  //     'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
  //   },
  // },
};
