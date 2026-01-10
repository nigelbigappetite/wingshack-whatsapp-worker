# Railway Session Persistence Setup

## Problem
Railway containers restart and lose the WhatsApp session tokens, causing repeated QR code generation.

## Solution: Configure Railway Volume

### Step 1: Add Volume in Railway Dashboard

1. Go to your Railway project: https://railway.app
2. Select your `wingshack-whatsapp-worker` service
3. Click on **Settings** tab
4. Scroll down to **Volumes** section
5. Click **+ New Volume**
6. Configure:
   - **Mount Path**: `/app/wpp-session`
   - **Name**: `wpp-session-storage` (or any name you prefer)
7. Click **Add**

### Step 2: Upload Local Session (Optional - if you want to use your scanned session)

If you've already scanned the QR code locally and want to use that session on Railway:

1. **Create a backup of your local session:**
   ```bash
   cd wingshack-whatsapp-worker
   tar -czf wpp-session-backup.tar.gz wpp-session/
   ```

2. **Upload to Railway using Railway CLI:**
   ```bash
   # Install Railway CLI if not installed
   npm i -g @railway/cli
   
   # Login to Railway
   railway login
   
   # Link to your project
   railway link
   
   # Upload the session files
   railway run --service wingshack-whatsapp-worker bash
   # Then inside the container:
   # cd /app
   # (upload your wpp-session folder here)
   ```

   **OR use Railway's file upload feature:**
   - In Railway dashboard, go to your service
   - Use the "Files" tab or "Shell" to upload files
   - Extract the backup to `/app/wpp-session/`

### Step 3: Redeploy

After adding the volume:
1. Railway will automatically redeploy
2. The session will persist across restarts
3. If you uploaded your local session, it should authenticate automatically
4. If not, access the Railway worker's public URL to scan QR code

### Step 4: Verify

Check Railway logs for:
- `[WPPCONNECT] WhatsApp client started successfully` (should appear after first scan)
- No repeated QR code generation
- Session tokens should be in `/app/wpp-session/wingshack-session/`

## Alternative: Manual Session Transfer

If you can't use volumes, you can:

1. **Copy session files manually:**
   - The session tokens are in `wpp-session/wingshack-session/Default/`
   - Key files: Local Storage, IndexedDB, cookies
   - These are browser profile files that WPPConnect uses

2. **Use Railway Shell:**
   ```bash
   railway run --service wingshack-whatsapp-worker
   # Then copy files to /app/wpp-session/
   ```

**Note:** Manual transfer is more complex and may not work perfectly due to browser profile differences. Using a Railway volume is the recommended approach.

## Current Status

✅ Local session scanned and authenticated  
✅ Session files saved in: `wpp-session/wingshack-session/`  
⏳ Railway volume needs to be configured  
⏳ Session needs to be uploaded to Railway (optional, can rescan on Railway)

