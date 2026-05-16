import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import pino from 'pino'
import yts from 'yt-search'
import readline from 'readline/promises'
import { fileURLToPath } from 'url'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const execAsync = promisify(exec)
const __filename = fileURLToPath(import.meta.url)

/* ================= CONFIGURATION ================= */
const log = (tag, m) => console.log(`[${new Date().toLocaleTimeString()}] [${tag}] ${m}`)

// ⚠️ Replace with your actual support link
const SUPPORT_LINK = 'https://chat.whatsapp.com/YOUR_INVITE_LINK_HERE'

// Cache directories
const CACHE_BASE = path.join(process.cwd(), 'cache')
const AUDIO_CACHE = path.join(CACHE_BASE, 'audio')
const LYRICS_CACHE = path.join(CACHE_BASE, 'lyrics')

await fs.mkdir(AUDIO_CACHE, { recursive: true })
await fs.mkdir(LYRICS_CACHE, { recursive: true })

/* ================= CACHE HELPERS ================= */
function sanitizeFilename(text) {
    return text.replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 100)
}

async function getCachedLyrics(title) {
    const file = path.join(LYRICS_CACHE, sanitizeFilename(title) + '.txt')
    try { return await fs.readFile(file, 'utf-8') } catch { return null }
}

async function saveCachedLyrics(title, content) {
    const file = path.join(LYRICS_CACHE, sanitizeFilename(title) + '.txt')
    await fs.writeFile(file, content, 'utf-8')
}

async function getCachedAudio(videoId) {
    const file = path.join(AUDIO_CACHE, videoId + '.m4a')
    try { return await fs.readFile(file) } catch { return null }
}

async function saveCachedAudio(videoId, buffer) {
    const file = path.join(AUDIO_CACHE, videoId + '.m4a')
    await fs.writeFile(file, buffer)
}

/* ================= LYRICS SOURCES (Genius first, fallbacks) ================= */
async function getRawLyrics(query) {
    const cleanQuery = query.split('(')[0].split('[')[0].trim()
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }

    // 1) Genius (primary)
    try {
        const res = await axios.get(
            `https://genius.com/api/search/multi?q=${encodeURIComponent(cleanQuery)}`,
            { headers }
        )
        const url = res.data.response.sections.find(s => s.type === 'top_hit')?.hits[0]?.result?.url
        if (url) {
            const { data } = await axios.get(url, { headers })
            const $ = cheerio.load(data)
            let lyrics = ''
            $('div[class^="Lyrics__Container"]').each((i, el) => {
                lyrics += $(el).text() + '\n'
            })
            lyrics = lyrics.trim()
            if (lyrics.length > 100) return lyrics
        }
    } catch (e) {
        log('⚠️ GENIUS', 'Genius scrape failed: ' + e.message)
    }

    // 2) LRCLIB
    try {
        const res = await axios.get(
            `https://lrclib.net/api/search?q=${encodeURIComponent(cleanQuery)}`
        )
        const plain = res.data?.[0]?.plainLyrics
        if (plain && plain.length > 50) return plain.trim()
    } catch (e) {}

    // 3) Azlyrics
    try {
        const azSearch = await axios.get(
            `https://search.azlyrics.com/search.php?q=${encodeURIComponent(cleanQuery)}`,
            { headers }
        )
        const $search = cheerio.load(azSearch.data)
        const link = $search('td.visitedlyr a').first().attr('href')
        if (link) {
            const { data } = await axios.get(link, { headers })
            const $ = cheerio.load(data)
            let l = ''
            $('div.col-xs-12.col-lg-8.text-center').find('div').each((i, el) => {
                if (!$(el).attr('class') && !$(el).attr('id')) l += $(el).text() + '\n'
            })
            const final = l.trim()
            if (final.length > 50) return final
        }
    } catch (e) {}

    return null
}

/* ================= FAST AUDIO DOWNLOAD (m4a) ================= */
async function downloadAudio(videoUrl, videoId) {
    const tmpDir = os.tmpdir()
    const outTemplate = path.join(tmpDir, `audio-${videoId}.%(ext)s`)

    log('🔧 YT-DLP', 'Downloading m4a...')
    const command = `yt-dlp -f "bestaudio[ext=m4a]/bestaudio" -o "${outTemplate}" --no-playlist "${videoUrl}"`
    const { stdout, stderr } = await execAsync(command)
    if (stderr) log('⚠️ YT-DLP stderr', stderr.slice(0, 200))
    if (stdout) log('📝 YT-DLP stdout', stdout.slice(0, 200))

    const dirContents = await fs.readdir(tmpDir)
    const audioFile = dirContents.find(f => f.startsWith(`audio-${videoId}`))
    if (!audioFile) throw new Error('yt‑dlp output file not found')

    const filePath = path.join(tmpDir, audioFile)
    const buffer = await fs.readFile(filePath)
    await fs.unlink(filePath)
    return buffer
}

/* ================= CORE BOT LOGIC ================= */
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth')
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        printQRInTerminal: false
    })

    if (!sock.authState.creds.registered) {
        console.clear()
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const phoneNumber = await rl.question('📱 Enter WhatsApp Number (e.g. 254...): ')
        const code = await sock.requestPairingCode(phoneNumber.trim())
        console.log(`\n👉 Your Pairing Code is: \x1b[32m${code}\x1b[0m`)
        rl.close()
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (u) => {
        if (u.connection === 'open') log('SYSTEM', '✅ Bot Live')
        if (u.connection === 'close') {
            log('SYSTEM', '❌ Connection lost. Restarting...')
            startBot()
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        const msg = messages[0]
        // ---- FIX: also accept offline ('append') messages ----
        if (!msg.message || msg.key.fromMe) return
        if (type !== 'notify' && type !== 'append') return

        const from = msg.key.remoteJid
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim()
        const pushName = msg.pushName || 'User'

        if (text.startsWith('.play ')) {
            const query = text.slice(6)

            log('🎵 REQ', `New .play from ${pushName}: "${query}"`)

            try {
                log('🔍 STEP', 'Sending SEARCHING message...')
                await sock.sendMessage(from, {
                    text: `🔍 *SEARCHING...*\n\n📊 *Query:* ${query}\n📋 *Requested by:* ${pushName}\n\nStatus: Fetching metadata from YouTube...`
                }, { quoted: msg })

                const search = await yts(query)
                const video = search.videos[0]
                if (!video) {
                    log('⚠️ FAIL', `No results for "${query}"`)
                    return await sock.sendMessage(from, { text: '❌ No results found.' })
                }

                log('✅ FOUND', `Title: ${video.title} | Duration: ${video.timestamp}`)
                const videoId = video.videoId

                log('🖼️ MEDIA', 'Sending thumbnail...')
                await sock.sendMessage(from, {
                    image: { url: video.thumbnail },
                    caption: `🔍 *SONGFOUND*\n\n🎵 *Title:* ${video.title}\n🕒 *Duration:* ${video.timestamp}\n📍 *Link:* ${video.url}\n\n📥 Downloading audio & lyrics...`
                }, { quoted: msg })

                // --- AUDIO ---
                let audioBuffer = await getCachedAudio(videoId)
                if (audioBuffer) {
                    log('💾 CACHE', 'Audio found in cache')
                } else {
                    log('🎧 AUDIO', 'Downloading fast m4a audio...')
                    audioBuffer = await downloadAudio(video.url, videoId)
                    await saveCachedAudio(videoId, audioBuffer)
                    log('💾 CACHE', 'Audio saved to cache')
                }

                log('📤 AUDIO', 'Sending audio message...')
                await sock.sendMessage(from, {
                    audio: audioBuffer,
                    mimetype: 'audio/mp4',
                    ptt: false
                }, { quoted: msg })
                log('✅ AUDIO', 'Audio sent')

                // --- LYRICS ---
                let lyrics = await getCachedLyrics(video.title)
                if (lyrics) {
                    log('💾 CACHE', 'Lyrics found in cache')
                } else {
                    log('📝 LYRICS', 'Scraping lyrics (Genius main)...')
                    const raw = await getRawLyrics(video.title)
                    if (raw) {
                        lyrics = raw   // raw, no cleaning
                        await saveCachedLyrics(video.title, lyrics)
                        log('💾 CACHE', 'Lyrics saved to cache')
                    }
                }

                if (lyrics) {
                    const finalText = `🎤 *LYRICS for ${video.title}*\n\n${lyrics.substring(0, 4000)}${lyrics.length > 4000 ? '\n\n⚠️ Lyrics truncated (too long)' : ''}`
                    await sock.sendMessage(from, { text: finalText }, { quoted: msg })
                    log('✅ LYRICS', 'Lyrics sent (raw)')
                } else {
                    await sock.sendMessage(from, { text: '❌ No lyrics found for this song.' })
                    log('⚠️ LYRICS', 'All sources failed')
                }

                log('✅ DONE', `.play request completed for ${pushName}`)

            } catch (err) {
                log('💥 ERROR', err.message)
                log('💥 STACK', err.stack || 'No stack trace')
                await sock.sendMessage(from, { text: `❌ Failed: ${err.message}` })
            }
        }

        if (text === '.support') {
            log('💬 SUPPORT', `Sent support link to ${pushName}`)
            await sock.sendMessage(from, {
                text: `💬 *SUPPORT GROUP*\n\n${SUPPORT_LINK}\n\n🔗 Tap the link to join us.`
            }, { quoted: msg })
        }
    })
}

startBot()	
