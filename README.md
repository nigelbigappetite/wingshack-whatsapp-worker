# WhatsApp Hub Worker

A persistent Node.js worker for WhatsApp integration using WPPConnect.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in your values:
```bash
cp .env.example .env
```

3. Build the project:
```bash
npm run build
```

## Usage

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

## Environment Variables

- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `DASHBOARD_WEBHOOK_URL` - Dashboard webhook endpoint URL
- `WHATSAPP_WEBHOOK_SECRET` - Webhook secret for authentication
- `POLL_INTERVAL_MS` - Polling interval in milliseconds (default: 1500)
- `MAX_ATTEMPTS` - Maximum retry attempts for failed messages (default: 5)

## Features

- **Inbound Messages**: Automatically forwards received WhatsApp messages to the dashboard webhook
- **Outbound Messages**: Polls Supabase for queued messages and sends them via WhatsApp
- **Session Persistence**: WhatsApp session is saved and persists across restarts
- **Error Handling**: Retries failed messages up to MAX_ATTEMPTS
- **Atomic Job Processing**: Ensures only one job is processed at a time

