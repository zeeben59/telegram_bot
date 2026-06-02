## Secrets & configuration

- Use `.env` for local secrets (do not commit). A safe example is provided in `.env.example`.
- This repo includes a `.gitignore` that excludes `.env` and `node_modules`.
- If you accidentally commit any secret (Telegram bot token or OpenAI API key), revoke and rotate them immediately.

## PostgreSQL setup

- The bot now uses PostgreSQL for persistence. Set `DATABASE_URL` in your environment (recommended) or provide `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, and `PGPORT`.
- On first run the bot will automatically create the required tables.

Example `DATABASE_URL` (do NOT commit this):
```
postgres://user:password@host:5432/database
```
# Telegram AI Bot (Node.js + Telegraf + OpenAI)

This repository contains a simple, production-ready Telegram chatbot backend using Node.js, `telegraf`, and the official OpenAI SDK. It uses CommonJS (`require(...)`) and dotenv for configuration.

## Folder structure

- .env                # Environment variables (do not commit)
- index.js            # Main bot implementation
- package.json        # Project manifest
- README.md

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file in the project root with these values:

```
BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN_HERE
OPENAI_API_KEY=YOUR_OPENAI_API_KEY_HERE
```

3. Start the bot:

```bash
npm start
```

## Features

- Replies “Thinking...” immediately after receiving a message.
- Sends user messages to OpenAI `gpt-4.1-mini` using the official SDK.
- Returns clean AI replies back to Telegram.
- Basic error handling and console logs for debugging.
- Graceful shutdown on `SIGINT`/`SIGTERM`.

## Notes

- Keep `.env` out of version control.
- Tune `max_tokens` and other OpenAI parameters in `index.js` as needed.

## Hosting and Docker

This repo includes a `Dockerfile` and `Procfile` to simplify hosting.

- To build and run locally with Docker:

```bash
docker build -t telegram-ai-coach .
docker run -e BOT_TOKEN=$BOT_TOKEN -e OPENAI_API_KEY=$OPENAI_API_KEY -p 3001:3001 telegram-ai-coach
```

- For Git-based hosts (Render, Railway, Heroku): push this repo and set the required env vars (`BOT_TOKEN`, `OPENAI_API_KEY`, optionally `DATABASE_URL`). Use the `node index.js` start command.

