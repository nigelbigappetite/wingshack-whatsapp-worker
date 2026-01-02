import 'dotenv/config'
import { create, Whatsapp } from '@wppconnect-team/wppconnect'
import { createClient } from '@supabase/supabase-js'
import axios from 'axios'
import * as path from 'path'
import * as fs from 'fs'

// Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const DASHBOARD_WEBHOOK_URL = process.env.DASHBOARD_WEBHOOK_URL
const WHATSAPP_WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '1500', 10)
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS || '5', 10)

// Validate environment variables
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DASHBOARD_WEBHOOK_URL || !WHATSAPP_WEBHOOK_SECRET) {
  console.error('Missing required environment variables')
  process.exit(1)
}

// Initialize Supabase admin client (service role)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

console.log('[SUPABASE] Admin client initialized')

// Normalize phone number to E.164 format (starts with +)
function normalizePhone(phone: string): string {
  // Remove WhatsApp ID suffix (@c.us or @g.us) if present
  let cleaned = phone.split('@')[0].trim()
  // Ensure it starts with +
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`
}

// Extract phone from WhatsApp message format
function extractPhoneFromWhatsAppId(whatsappId: string): string {
  // WhatsApp IDs are in format: 5511999999999@c.us (individual) or 120363123456789012@g.us (group)
  // Remove the @c.us or @g.us suffix
  return whatsappId.split('@')[0]
}

// Convert E.164 phone number to WhatsApp ID format
// E.164: +447900000001 -> WhatsApp ID: 447900000001@c.us
function e164ToWhatsAppId(e164Phone: string): string {
  // Remove leading + if present
  const cleaned = e164Phone.trim().replace(/^\+/, '')
  // Append @c.us suffix for individual chat
  return `${cleaned}@c.us`
}

// WhatsApp client instance
let client: Whatsapp | null = null
let isProcessingJob = false

// Clean up stale Chromium lock files from session profile directory
// This prevents "profile appears to be in use" errors on Railway
// The SingletonLock file contains hostname info from previous containers, causing false positives
function cleanupChromiumLockFiles(sessionProfileDir: string) {
  const lockFiles = [
    'SingletonLock',
    'SingletonCookie',
    'SingletonSocket',
    'Lockfile',
  ]

  let removedCount = 0
  
  // First, try to remove known lock files
  lockFiles.forEach((lockFile) => {
    const lockFilePath = path.join(sessionProfileDir, lockFile)
    try {
      if (fs.existsSync(lockFilePath)) {
        // Force remove with multiple strategies
        try {
          // Try normal unlink first
          fs.unlinkSync(lockFilePath)
          console.log(`[WPPCONNECT] Removed stale lock file: ${lockFile}`)
          removedCount++
        } catch (unlinkError: any) {
          // If unlink fails, try chmod then unlink (in case of permission issues)
          try {
            fs.chmodSync(lockFilePath, 0o666)
            fs.unlinkSync(lockFilePath)
            console.log(`[WPPCONNECT] Force removed lock file: ${lockFile}`)
            removedCount++
          } catch (forceError: any) {
            console.warn(`[WPPCONNECT] Could not remove lock file ${lockFile}:`, forceError.message)
          }
        }
      }
    } catch (error: any) {
      console.warn(`[WPPCONNECT] Error checking lock file ${lockFile}:`, error.message)
    }
  })
  
  // Also check for any files matching lock patterns (in case of variations)
  try {
    if (fs.existsSync(sessionProfileDir)) {
      const files = fs.readdirSync(sessionProfileDir)
      files.forEach((file) => {
        // Remove any files that look like lock files
        if (file.startsWith('Singleton') || file === 'Lockfile' || file.startsWith('lock')) {
          const lockFilePath = path.join(sessionProfileDir, file)
          try {
            if (fs.existsSync(lockFilePath)) {
              fs.unlinkSync(lockFilePath)
              console.log(`[WPPCONNECT] Removed additional lock file: ${file}`)
              removedCount++
            }
          } catch (error: any) {
            // Ignore errors for additional files
          }
        }
      })
    }
  } catch (error: any) {
    // Ignore errors when scanning directory
  }
  
  if (removedCount > 0) {
    console.log(`[WPPCONNECT] Cleanup complete: removed ${removedCount} lock files`)
  } else {
    console.log(`[WPPCONNECT] No lock files found to clean`)
  }
}

// Start WPPConnect client
async function startWhatsAppClient() {
  const maxRetries = 3
  let lastError: any = null
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[WPPCONNECT] Starting WhatsApp client... (attempt ${attempt}/${maxRetries})`)
      
      // WPPConnect session storage location:
      // Session tokens are stored in: ./wpp-session/wingshack-session/
      // This folder contains the WhatsApp authentication tokens and browser session data
      // Ensure wpp-session directory exists
      const sessionDir = path.join(process.cwd(), 'wpp-session')
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true })
        console.log(`[WPPCONNECT] Created session directory: ${sessionDir}`)
      }

      // Session profile directory path: /app/wpp-session/wingshack-session (on Railway)
      const sessionProfileDir = path.join(sessionDir, 'wingshack-session')
      
      // WPPConnect stores session tokens in the session directory
      // We must preserve these tokens to avoid re-authentication on every restart
      // IMPORTANT: Only clean Chromium lock files, NEVER delete the entire directory
      // Deleting the directory would remove session tokens and force re-authentication
      if (fs.existsSync(sessionProfileDir)) {
        console.log(`[WPPCONNECT] Session directory exists, cleaning only Chromium lock files`)
        console.log(`[WPPCONNECT] Preserving session tokens in: ${sessionProfileDir}`)
        
        // Aggressive cleanup: remove lock files multiple times to catch any that get recreated
        cleanupChromiumLockFiles(sessionProfileDir)
        await new Promise(resolve => setTimeout(resolve, 200))
        cleanupChromiumLockFiles(sessionProfileDir) // Clean again after short delay
      } else {
        // Directory doesn't exist, create it
        fs.mkdirSync(sessionProfileDir, { recursive: true })
        console.log(`[WPPCONNECT] Created browser profile directory: ${sessionProfileDir}`)
      }
      
      // Longer delay to ensure filesystem operations complete and locks are fully cleared
      // This is critical on Railway where container hostnames change between restarts
      await new Promise(resolve => setTimeout(resolve, 800))
      
      client = await create({
        session: 'wingshack-session',
        folderNameToken: 'wpp-session',
        catchQR: (base64Qr: string) => {
          console.log('\n=== QR CODE ===')
          console.log('Scan this QR code with WhatsApp:')
          
          // Extract base64 data (remove data:image/png;base64, prefix if present)
          const base64Data = base64Qr.replace(/^data:image\/png;base64,/, '')
          
          // Save QR code as PNG file for easy access
          try {
            const qrCodePath = path.join(process.cwd(), 'wpp-session', 'qr-code.png')
            const qrCodeBuffer = Buffer.from(base64Data, 'base64')
            fs.writeFileSync(qrCodePath, qrCodeBuffer)
            console.log(`✓ QR code saved to: ${qrCodePath}`)
          } catch (saveError: any) {
            console.warn('Failed to save QR code file:', saveError.message)
          }
          
          // Log base64 data in a clean format for easy copying
          console.log('\n--- Base64 QR Code Data (copy everything below this line) ---')
          console.log(base64Data)
          console.log('--- End of Base64 Data ---\n')
          
          console.log('To decode the QR code:')
          console.log('1. Copy the base64 data above (between the lines)')
          console.log('2. Go to: https://base64.guru/converter/decode/image')
          console.log('3. Paste the base64 data and download the PNG')
          console.log('4. Or use this command locally:')
          console.log(`   echo "${base64Data.substring(0, 50)}..." | base64 -d > qr-code.png`)
          console.log('5. Or download from Railway: railway run cat wpp-session/qr-code.png > qr-code.png')
          console.log('===============\n')
        },
        statusFind: (statusSession: string) => {
          console.log(`[WPPCONNECT] Session status: ${statusSession}`)
        },
        autoClose: 0,
        puppeteerOptions: {
          headless: true,
          executablePath: process.env.CHROME_BIN || undefined,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection',
            '--disable-session-crashed-bubble',
            '--disable-infobars',
            '--disable-breakpad',
          ],
        },
      })

      console.log('[WPPCONNECT] WhatsApp client started successfully')
      console.log(`[WPPCONNECT] Session tokens persisted to: ${sessionProfileDir}`)

      // Set up inbound message handler
    client.onMessage(async (message: any) => {
      try {
        // Ignore group messages (groups have @g.us suffix)
        if (message.from && message.from.includes('@g.us')) {
          console.log(`[INBOUND] Ignoring group message from ${message.from}`)
          return
        }

        // Only process text messages
        if (message.type !== 'chat' || !message.body) {
          return
        }

        // Extract and normalize phone number
        const rawPhone = extractPhoneFromWhatsAppId(message.from)
        const senderPhone = normalizePhone(rawPhone)
        const messageBody = message.body
        const waMessageId = message.id?.id || message.id
        const timestamp = new Date().toISOString()

        console.log(`[INBOUND] Received message from ${senderPhone}: ${messageBody.substring(0, 50)}...`)

        // Forward to dashboard webhook
        try {
          const response = await axios.post(
            DASHBOARD_WEBHOOK_URL!,
            {
              from_phone_e164: senderPhone,
              body: messageBody,
              wa_message_id: waMessageId,
              timestamp: timestamp,
            },
            {
              headers: {
                'Content-Type': 'application/json',
                'x-webhook-secret': WHATSAPP_WEBHOOK_SECRET!,
              },
            }
          )

          if (response.status === 200) {
            console.log(`[INBOUND] Successfully forwarded message from ${senderPhone}`)
          } else {
            console.error(`[INBOUND] Failed to forward message from ${senderPhone}: Status ${response.status}`)
          }
        } catch (error: any) {
          console.error(`[INBOUND] Error forwarding message from ${senderPhone}:`, error.message)
        }
      } catch (error: any) {
        console.error('[INBOUND] Error processing message:', error.message)
      }
    })

      console.log('[INBOUND] Message handler registered')
      return // Success, exit retry loop
      
    } catch (error: any) {
      lastError = error
      const errorMessage = error.message || String(error)
      
      // Check if it's a singleton lock error
      if (errorMessage.includes('profile appears to be in use') || errorMessage.includes('Code: 21')) {
        console.warn(`[WPPCONNECT] Attempt ${attempt} failed with singleton lock error, retrying...`)
        
        // Aggressively clean up lock files multiple times before retry
        const sessionProfileDir = path.join(path.join(process.cwd(), 'wpp-session'), 'wingshack-session')
        console.log(`[WPPCONNECT] Performing aggressive lock file cleanup before retry...`)
        cleanupChromiumLockFiles(sessionProfileDir)
        await new Promise(resolve => setTimeout(resolve, 300))
        cleanupChromiumLockFiles(sessionProfileDir)
        await new Promise(resolve => setTimeout(resolve, 300))
        cleanupChromiumLockFiles(sessionProfileDir)
        
        // Wait longer before retry (exponential backoff with minimum 1 second)
        if (attempt < maxRetries) {
          const delay = Math.max(1000, 500 * attempt)
          console.log(`[WPPCONNECT] Waiting ${delay}ms before retry...`)
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }
      }
      
      // If not a singleton error or max retries reached, throw
      console.error(`[WPPCONNECT] Attempt ${attempt} failed:`, errorMessage)
      if (attempt === maxRetries) {
        throw error
      }
    }
  }
  
  // If we get here, all retries failed
  if (lastError) {
    console.error('[WPPCONNECT] Error starting WhatsApp client after all retries:', lastError.message)
    throw lastError
  }
  
  throw new Error('Failed to start WhatsApp client')
}

// Process outbound message job
async function processOutboundJob() {
  if (isProcessingJob) {
    return
  }

  isProcessingJob = true

  try {
    // Fetch oldest queued job
    console.log('[OUTBOUND] Polling for queued jobs...')
    const { data: jobs, error: queryError } = await supabase
      .from('outbox_jobs')
      .select('*')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1)

    if (queryError) {
      console.error('[OUTBOUND] Error querying jobs:', queryError.message)
      return
    }

    if (!jobs || jobs.length === 0) {
      return // No jobs to process
    }

    const job = jobs[0]
    console.log(`[OUTBOUND] Found job ${job.id} for ${job.to_phone_e164}`)

    // Update job to processing and increment attempts
    const currentAttempts = (job.attempts || 0) + 1
    console.log(`[OUTBOUND] Updating job ${job.id} to processing (attempt ${currentAttempts})`)
    
    const { data: updatedJob, error: updateError } = await supabase
      .from('outbox_jobs')
      .update({
        status: 'processing',
        attempts: currentAttempts,
      })
      .eq('id', job.id)
      .eq('status', 'queued') // Ensure it's still queued (atomic check)
      .select()
      .single()

    if (updateError || !updatedJob) {
      console.error(`[OUTBOUND] Failed to claim job ${job.id}:`, updateError?.message || 'Job already claimed')
      return
    }

    const normalizedPhone = normalizePhone(updatedJob.to_phone_e164)
    // Convert E.164 to WhatsApp ID format for WPPConnect
    // Remove leading "+" and append "@c.us"
    const whatsappId = e164ToWhatsAppId(normalizedPhone)
    console.log(`[OUTBOUND] Sending message to ${normalizedPhone} as ${whatsappId}`)

    // Send message via WPPConnect
    try {
      if (!client) {
        throw new Error('WhatsApp client not initialized')
      }

      await client.sendText(whatsappId, updatedJob.body)
      console.log(`[OUTBOUND] Successfully sent message to ${normalizedPhone} as ${whatsappId}`)

      // Update job status to sent
      console.log(`[OUTBOUND] Updating job ${updatedJob.id} status to 'sent'`)
      await supabase
        .from('outbox_jobs')
        .update({ status: 'sent' })
        .eq('id', updatedJob.id)

      // Update message status to sent
      if (updatedJob.message_id) {
        console.log(`[OUTBOUND] Updating message ${updatedJob.message_id} status to 'sent'`)
        await supabase
          .from('messages')
          .update({ status: 'sent' })
          .eq('id', updatedJob.message_id)
      }
    } catch (sendError: any) {
      console.error(`[OUTBOUND] Failed to send message to ${normalizedPhone} as ${whatsappId}:`, sendError.message)

      const newAttempts = updatedJob.attempts || 1
      const isMaxAttemptsReached = newAttempts >= MAX_ATTEMPTS

      console.log(`[OUTBOUND] Job ${updatedJob.id} failed (attempt ${newAttempts}/${MAX_ATTEMPTS})`)

      // Update job with error and status
      const newStatus = isMaxAttemptsReached ? 'failed' : 'queued'
      console.log(`[OUTBOUND] Updating job ${updatedJob.id} status to '${newStatus}'`)
      
      await supabase
        .from('outbox_jobs')
        .update({
          status: newStatus,
          last_error: sendError.message,
        })
        .eq('id', updatedJob.id)

      // Update message status to failed only if job is failed
      if (isMaxAttemptsReached && updatedJob.message_id) {
        console.log(`[OUTBOUND] Updating message ${updatedJob.message_id} status to 'failed'`)
        await supabase
          .from('messages')
          .update({ status: 'failed' })
          .eq('id', updatedJob.message_id)
      }
    }
  } catch (error: any) {
    console.error('[OUTBOUND] Error processing job:', error.message)
  } finally {
    isProcessingJob = false
  }
}

// Start outbound polling loop
function startOutboundLoop() {
  console.log(`[OUTBOUND] Starting polling loop (interval: ${POLL_INTERVAL_MS}ms)`)
  
  setInterval(() => {
    processOutboundJob()
  }, POLL_INTERVAL_MS)
}

// Main function
async function main() {
  console.log('=== WhatsApp Hub Worker Starting ===')
  console.log(`Poll interval: ${POLL_INTERVAL_MS}ms`)
  console.log(`Max attempts: ${MAX_ATTEMPTS}`)
  console.log(`Dashboard webhook: ${DASHBOARD_WEBHOOK_URL}`)
  console.log('===================================\n')

  // Start WhatsApp client
  await startWhatsAppClient()

  // Start outbound polling loop
  startOutboundLoop()
  
  console.log('\n[SYSTEM] Worker is running. Press Ctrl+C to stop.\n')

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...')
    if (client) {
      await client.close()
    }
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    console.log('\nShutting down gracefully...')
    if (client) {
      await client.close()
    }
    process.exit(0)
  })
}

// Start the worker
main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})

