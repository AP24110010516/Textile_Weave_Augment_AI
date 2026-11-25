const express = require('express')
const multer = require('multer')
const dotenv = require('dotenv')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { promisify } = require('node:util')
const { DatabaseSync } = require('node:sqlite')
const sharp = require('sharp')
const {
  buildColorVariationPrompt,
  buildTextilePrompt,
  mapDatasetImageStrength,
  normalizeDesiredFabricColor,
  normalizeFabricType,
} = require('./colorVariation.cjs')

dotenv.config({ path: path.join(__dirname, '.env') })

const app = express()
const port = Number(process.env.PORT) || 3001
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist')
const maxImageBytes = 15 * 1024 * 1024
const sessionLifetime = 7 * 24 * 60 * 60 * 1000
const maxImagePixels = 24_000_000
const scrypt = promisify(crypto.scrypt)
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'weaveaugment.sqlite')
fs.mkdirSync(path.dirname(databasePath), { recursive: true })
const database = new DatabaseSync(databasePath)
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`)
app.use(express.json({ limit: '8kb' }))
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxImageBytes, files: 1 },
  fileFilter(_request, file, callback) {
    if (!['image/png', 'image/jpeg'].includes(file.mimetype)) {
      callback(new Error('Please upload a PNG or JPEG image.'))
      return
    }
    callback(null, true)
  },
})
const authAttempts = new Map()

function authRateLimit(request, response, next) {
  const now = Date.now()
  const key = request.ip
  if (authAttempts.size > 10000) {
    for (const [attemptKey, attempt] of authAttempts) {
      if (attempt.expiresAt <= now) authAttempts.delete(attemptKey)
    }
  }
  const current = authAttempts.get(key)
  if (!current || current.expiresAt <= now) {
    authAttempts.set(key, { count: 1, expiresAt: now + 15 * 60 * 1000 })
    next()
    return
  }
  if (current.count >= 10) {
    response.status(429).json({ error: 'Too many authentication attempts. Please wait and try again.' })
    return
  }
  current.count += 1
  next()
}

function normalizeHost(hostHeader) {
  if (!hostHeader) return ''
  const first = hostHeader.split(',')[0].trim().toLowerCase()
  return first.replace(/^(?:127\.0\.0\.1|\[::1\])(?::|$)/, 'localhost:')
}

function requireSameOrigin(request, response, next) {
  const origin = request.get('origin')
  if (!origin) {
    next()
    return
  }
  try {
    const originHost = normalizeHost(new URL(origin).host)
    const requestHost = normalizeHost(request.get('x-forwarded-host') || request.get('host'))
    if (!originHost || !requestHost || originHost !== requestHost) {
      response.status(403).json({ error: 'Cross-origin authentication requests are not allowed.' })
      return
    }
  } catch {
    response.status(403).json({ error: 'Invalid request origin.' })
    return
  }
  next()
}

function setSessionCookie(response, token, rememberMe = false) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  const maxAge = rememberMe ? `; Max-Age=${Math.floor(sessionLifetime / 1000)}` : ''
  response.setHeader('Set-Cookie', `weaveaugment_session=${token}; Path=/; HttpOnly; SameSite=Lax${maxAge}${secure}`)
}

function clearSessionCookie(response) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  response.setHeader('Set-Cookie', `weaveaugment_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`)
}

function requestSessionToken(request) {
  const cookies = request.headers.cookie || ''
  const match = cookies.match(/(?:^|;\s*)weaveaugment_session=([a-f0-9]{64})(?:;|$)/)
  return match?.[1] || null
}

function sessionUser(request) {
  const token = requestSessionToken(request)
  if (!token) return null
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const row = database.prepare(`
    SELECT users.id, users.name, users.email
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash, Date.now())
  return row || null
}

app.post('/api/auth/signup', requireSameOrigin, authRateLimit, async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : ''
  const password = typeof request.body?.password === 'string' ? request.body.password : ''
  if (name.length < 1 || name.length > 100 || /[\u0000-\u001f]/.test(name)) {
    response.status(400).json({ error: 'Enter a name between 1 and 100 characters.' })
    return
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    response.status(400).json({ error: 'Enter a valid email address.' })
    return
  }
  if (!password) {
    response.status(400).json({ error: 'Enter a password.' })
    return
  }

  try {
    const salt = crypto.randomBytes(16).toString('hex')
    const passwordHash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    const token = crypto.randomBytes(32).toString('hex')
    let transactionStarted = false
    let user
    try {
      database.exec('BEGIN IMMEDIATE')
      transactionStarted = true
      const result = database.prepare('INSERT INTO users (name, email, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(name, email, salt, passwordHash, Date.now())
      user = { id: Number(result.lastInsertRowid), name, email }
      database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
      database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(crypto.createHash('sha256').update(token).digest('hex'), user.id, Date.now() + sessionLifetime)
      database.exec('COMMIT')
      transactionStarted = false
    } catch (error) {
      if (transactionStarted) database.exec('ROLLBACK')
      throw error
    }
    setSessionCookie(response, token, true)
    response.status(201).json({ user })
  } catch (error) {
    if (
      error?.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE' ||
      error?.errcode === 2067 ||
      (typeof error?.message === 'string' && error.message.includes('UNIQUE constraint failed'))
    ) {
      response.status(409).json({ error: 'An account with this email already exists.' })
      return
    }
    console.error('Account creation failed:', error)
    response.status(500).json({ error: 'The account could not be created. Please try again.' })
  }
})

app.post('/api/auth/login', requireSameOrigin, authRateLimit, async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : ''
  const password = typeof request.body?.password === 'string' ? request.body.password : ''
  if (!email || email.length > 254 || !password) {
    response.status(400).json({ error: 'Enter your email and password.' })
    return
  }

  try {
    const row = database.prepare('SELECT id, name, email, password_salt, password_hash FROM users WHERE email = ?').get(email)
    const salt = row?.password_salt || 'weaveaugment-invalid-user-salt'
    const expected = row ? Buffer.from(row.password_hash) : Buffer.alloc(64)
    const actual = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    if (!row || !crypto.timingSafeEqual(expected, actual)) {
      response.status(401).json({ error: 'Email or password is incorrect.' })
      return
    }

    const token = crypto.randomBytes(32).toString('hex')
    const previousToken = requestSessionToken(request)
    database.exec('BEGIN IMMEDIATE')
    try {
      if (previousToken) {
        database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(crypto.createHash('sha256').update(previousToken).digest('hex'))
      }
      database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
      database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(crypto.createHash('sha256').update(token).digest('hex'), row.id, Date.now() + sessionLifetime)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    setSessionCookie(response, token, request.body?.rememberMe === true)
    response.json({ user: { id: row.id, name: row.name, email: row.email } })
  } catch (error) {
    console.error('Account login failed:', error)
    response.status(500).json({ error: 'Sign-in failed unexpectedly. Please try again.' })
  }
})

app.get('/api/auth/session', (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  const user = sessionUser(request)
  if (!user) {
    response.status(401).json({ error: 'You are not signed in.' })
    return
  }
  response.json({ user })
})

app.post('/api/auth/logout', requireSameOrigin, (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  const token = requestSessionToken(request)
  if (token) {
    database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(crypto.createHash('sha256').update(token).digest('hex'))
  }
  clearSessionCookie(response)
  response.status(204).end()
})

app.get('/api/status', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  response.json({ sdxlConfigured: Boolean(process.env.STABILITY_API_KEY?.trim()) })
})

function isValidImage(file) {
  const bytes = file.buffer
  if (file.mimetype === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }
  return file.mimetype === 'image/jpeg' && bytes.length >= 3 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function upstreamErrorMessage(status, details) {
  const detail = details?.message || (Array.isArray(details?.errors) ? details.errors.join(' ') : '')
  if (status === 401) return 'Stability AI rejected the API key. Check STABILITY_API_KEY in your .env file.'
  if (status === 402) return 'Your Stability AI account has insufficient credits. Add credits and try again.'
  if (status === 403) return 'Stability AI declined this request due to its content policy.'
  if (status === 429) return detail ? `Stability AI rate limit reached: ${detail}` : 'Stability AI rate limit reached. Wait briefly and try again.'
  if (status === 413) return 'The uploaded image or request is too large for Stability AI.'
  if (status === 400 || status === 422) return `Stability AI could not process this request${detail ? `: ${detail}` : '.'}`
  if (status === 404) return `The documented SDXL image-to-image service is unavailable for this account or engine${detail ? `: ${detail}` : '.'}`
  return `Stability AI returned an error (${status})${detail ? `: ${detail}` : '.'}`
}

async function imagesVisiblyDiffer(firstBuffer, secondBuffer) {
  const [first, second] = await Promise.all([
    sharp(firstBuffer, { limitInputPixels: maxImagePixels }).resize(128, 128, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(secondBuffer, { limitInputPixels: maxImagePixels }).resize(128, 128, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ])
  if (first.info.width !== second.info.width || first.info.height !== second.info.height ||
      first.info.channels !== 3 || second.info.channels !== 3) return false
  let changedPixels = 0
  let totalDifference = 0
  for (let index = 0; index < first.data.length; index += 3) {
    const difference = Math.abs(first.data[index] - second.data[index]) +
      Math.abs(first.data[index + 1] - second.data[index + 1]) +
      Math.abs(first.data[index + 2] - second.data[index + 2])
    totalDifference += difference
    if (difference >= 15) changedPixels += 1
  }
  const pixelCount = first.data.length / 3
  return totalDifference / pixelCount / 3 >= 1.5 || changedPixels / pixelCount >= 0.01
}

async function generatedImageDiffersFromSource(sourceBuffer, generatedBase64) {
  return imagesVisiblyDiffer(sourceBuffer, Buffer.from(generatedBase64, 'base64'))
}

async function applyDefectRefinement(generatedBase64, defectType) {
  const source = await sharp(Buffer.from(generatedBase64, 'base64'), { limitInputPixels: maxImagePixels })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = source.info
  if (channels !== 4) return generatedBase64
  const pixels = Buffer.from(source.data)
  const normalized = String(defectType || 'Hole').toLowerCase()
  const hash = crypto.createHash('sha256').update(generatedBase64.slice(0, 4096)).update(normalized).digest()
  const seed = hash.readUInt32BE(0)
  const random = (index) => {
    let value = (seed ^ Math.imul(index + 1, 0x45d9f3b)) >>> 0
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
    return ((value ^ (value >>> 16)) >>> 0) / 4294967295
  }
  const centerX = width * (0.42 + random(1) * 0.16)
  const centerY = height * (0.42 + random(2) * 0.16)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels
      let affected = false
      if (normalized.includes('hole')) {
        const radiusX = width * (0.055 + random(3) * 0.025)
        const radiusY = height * (0.07 + random(4) * 0.025)
        const angle = random(5) * Math.PI
        const dx = x - centerX
        const dy = y - centerY
        const rx = dx * Math.cos(angle) + dy * Math.sin(angle)
        const ry = -dx * Math.sin(angle) + dy * Math.cos(angle)
        const boundary = 1 + Math.sin(Math.atan2(ry, rx) * 7 + random(6) * 2) * 0.08
        const distance = (rx * rx) / ((radiusX * boundary) ** 2) + (ry * ry) / ((radiusY * boundary) ** 2)
        if (distance <= 1) {
          const depth = 0.45 + random(y * width + x) * 0.25
          const weave = ((x + y) % 9 < 2) ? 18 : 0
          pixels[offset] = Math.round(pixels[offset] * depth + 18 + weave)
          pixels[offset + 1] = Math.round(pixels[offset + 1] * depth + 14 + weave)
          pixels[offset + 2] = Math.round(pixels[offset + 2] * depth + 10 + weave)
          affected = true
        } else if (distance <= 1.28) {
          pixels[offset] = Math.round(pixels[offset] * 0.72 + 30)
          pixels[offset + 1] = Math.round(pixels[offset + 1] * 0.72 + 28)
          pixels[offset + 2] = Math.round(pixels[offset + 2] * 0.72 + 22)
          affected = true
        }
      } else if (normalized.includes('scratch')) {
        const scratchAngle = -0.35 + random(7) * 0.7
        for (let line = -2; line <= 2; line += 1) {
          const lineOffset = line * 5
          const projected = (x - centerX) * Math.sin(scratchAngle) - (y - centerY) * Math.cos(scratchAngle)
          const along = (x - centerX) * Math.cos(scratchAngle) + (y - centerY) * Math.sin(scratchAngle)
          if (Math.abs(projected - lineOffset) <= 1.8 && Math.abs(along) < width * 0.22) {
            pixels[offset] = Math.round(pixels[offset] * 0.48 + 42)
            pixels[offset + 1] = Math.round(pixels[offset + 1] * 0.48 + 38)
            pixels[offset + 2] = Math.round(pixels[offset + 2] * 0.48 + 34)
            affected = true
          }
        }
      } else if (normalized.includes('stain')) {
        const rx = (x - centerX) / (width * 0.16)
        const ry = (y - centerY) / (height * 0.14)
        const distance = rx * rx + ry * ry
        if (distance <= 1) {
          const noise = random(y * width + x)
          const alpha = Math.max(0, (1 - distance) * (0.48 + noise * 0.18))
          pixels[offset] = Math.round(pixels[offset] * (1 - alpha) + 112 * alpha)
          pixels[offset + 1] = Math.round(pixels[offset + 1] * (1 - alpha) + 67 * alpha)
          pixels[offset + 2] = Math.round(pixels[offset + 2] * (1 - alpha) + 38 * alpha)
          affected = true
        }
      } else if (normalized.includes('tear')) {
        const normal = (y - centerY) - ((x - centerX) * (0.28 + random(8) * 0.12))
        const irregular = Math.sin(x / 13 + random(9) * 3) * 5
        if (Math.abs(normal - irregular) <= 8 && Math.abs(x - centerX) < width * 0.22) {
          pixels[offset] = Math.round(pixels[offset] * 0.42 + 18)
          pixels[offset + 1] = Math.round(pixels[offset + 1] * 0.42 + 16)
          pixels[offset + 2] = Math.round(pixels[offset + 2] * 0.42 + 14)
          affected = true
        }
      } else {
        const rx = (x - centerX) / (width * 0.09)
        const ry = (y - centerY) / (height * 0.09)
        if (rx * rx + ry * ry <= 1) {
          pixels[offset] = Math.round(pixels[offset] * 0.58 + 25)
          pixels[offset + 1] = Math.round(pixels[offset + 1] * 0.58 + 20)
          pixels[offset + 2] = Math.round(pixels[offset + 2] * 0.58 + 18)
          affected = true
        }
      }
      if (affected) pixels[offset + 3] = 255
    }
  }
  const refined = await sharp(pixels, { raw: { width, height, channels } })
    .removeAlpha()
    .png()
    .toBuffer()
  return refined.toString('base64')
}

app.post('/api/stable-diffusion/augment', (request, response) => {
  upload.single('image')(request, response, async (uploadError) => {
    if (uploadError) {
      const status = uploadError.code === 'LIMIT_FILE_SIZE' ? 413 : 400
      response.status(status).json({ error: uploadError.message })
      return
    }

    try {
      if (!process.env.STABILITY_API_KEY?.trim()) {
        response.status(503).json({ error: 'Stability AI is not configured. Add STABILITY_API_KEY to backend/.env and restart the server.' })
        return
      }
      if (!request.file) {
        response.status(400).json({ error: 'An image file is required.' })
        return
      }
      if (!isValidImage(request.file)) {
        response.status(400).json({ error: 'The uploaded file contents do not match a valid PNG or JPEG image.' })
        return
      }

      let prompt = typeof request.body.prompt === 'string' ? request.body.prompt.trim() : ''
      let negativePrompt = typeof request.body.negativePrompt === 'string' ? request.body.negativePrompt.trim() : ''
      const defectType = typeof request.body.defectType === 'string' ? request.body.defectType.trim() : ''
      const taskMode = typeof request.body.taskMode === 'string' ? request.body.taskMode.trim() : ''
      if (['dataset-builder', 'defect-creation'].includes(taskMode) &&
          !['Hole', 'Stain', 'Scratch', 'Tear'].includes(defectType)) {
        response.status(400).json({ error: 'Choose a supported defect type.' })
        return
      }
      let fabricType
      try {
        fabricType = normalizeFabricType(request.body.fabricType)
      } catch (error) {
        response.status(400).json({ error: error.message })
        return
      }
      if (taskMode === 'color-variation') {
        let desiredFabricColor
        try {
          desiredFabricColor = normalizeDesiredFabricColor(request.body.desiredFabricColor)
        } catch (error) {
          response.status(400).json({ error: error.message })
          return
        }
        prompt = buildColorVariationPrompt(prompt, desiredFabricColor)
      }
      if (fabricType && taskMode !== 'dataset-builder' && taskMode !== 'color-variation') {
        prompt = buildTextilePrompt(prompt, fabricType)
        negativePrompt = `${negativePrompt} incorrect fabric type, conflicting fiber material, inaccurate weave structure`
      }
      const uiStrength = Number(request.body.imageStrength)
      const variations = Number(request.body.variations)
      if (!prompt || prompt.length > 2000) {
        response.status(400).json({ error: 'A positive prompt of 1 to 2000 characters is required.' })
        return
      }
      if (negativePrompt.length > 2000) {
        response.status(400).json({ error: 'The negative prompt must be 2000 characters or fewer.' })
        return
      }
      if (!Number.isFinite(uiStrength) || uiStrength < 0.25 || uiStrength > 0.35) {
        response.status(400).json({ error: 'Image strength must be between 0.25 and 0.35.' })
        return
      }
      const imageStrength = taskMode === 'dataset-builder'
        ? mapDatasetImageStrength(uiStrength)
        : uiStrength
      if (!Number.isInteger(variations) || variations < 1 || variations > 50) {
        response.status(400).json({ error: 'Requested variations must be a whole number from 1 to 50.' })
        return
      }

      const results = []
      const acceptedImageBuffers = []
      while (results.length < variations) {
        const samples = Math.min(10, variations - results.length)
        const form = new FormData()
        form.append('init_image', new Blob([request.file.buffer], { type: request.file.mimetype }), request.file.originalname)
        form.append('init_image_mode', 'IMAGE_STRENGTH')
        form.append('image_strength', String(imageStrength))
        form.append('text_prompts[0][text]', prompt)
        form.append('text_prompts[0][weight]', '1')
        if (negativePrompt) {
          form.append('text_prompts[1][text]', negativePrompt)
          form.append('text_prompts[1][weight]', '-1')
        }
        form.append('samples', String(samples))
        form.append('steps', '30')

        let upstream
        try {
          upstream = await fetch('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
              Accept: 'application/json',
            },
            body: form,
            signal: AbortSignal.timeout(180000),
          })
        } catch (error) {
          console.error('Could not reach Stability AI image-to-image endpoint:', error)
          const message = error.name === 'TimeoutError'
            ? 'The Stability AI request timed out. Try fewer variations or try again later.'
            : 'Could not connect to Stability AI. Check your internet connection and try again.'
          response.status(502).json({ error: message })
          return
        }

        if (!upstream.ok) {
          let details = null
          try {
            details = await upstream.json()
          } catch {
            details = null
          }
          console.error('Stability AI image-to-image request failed:', {
            status: upstream.status,
            requestId: details && typeof details === 'object' && typeof details.id === 'string' ? details.id : undefined,
            errorName: details && typeof details === 'object' && typeof details.name === 'string' ? details.name : undefined,
          })
          response.status(upstream.status >= 500 ? 502 : upstream.status).json({
            error: upstreamErrorMessage(upstream.status, details),
          })
          return
        }

        let data
        try {
          data = await upstream.json()
        } catch {
          response.status(502).json({ error: 'Stability AI returned an unreadable response.' })
          return
        }
        if (!Array.isArray(data.artifacts)) {
          response.status(502).json({ error: 'Stability AI returned no generated images.' })
          return
        }

        const previousCount = results.length
        for (const artifact of data.artifacts) {
          if (results.length >= variations) break
          if (artifact.finishReason === 'CONTENT_FILTERED') continue
          if (typeof artifact.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(artifact.base64)) continue
          let differsFromSource = false
          try {
            differsFromSource = await generatedImageDiffersFromSource(request.file.buffer, artifact.base64)
          } catch (error) {
            console.error('Could not validate generated image against source:', error)
          }
          if (!differsFromSource) continue
          let outputBase64 = artifact.base64
          if (taskMode === 'defect-creation' && defectType) {
            try {
              outputBase64 = await applyDefectRefinement(outputBase64, defectType)
            } catch (error) {
              console.error('Could not apply defect refinement:', error)
              response.status(422).json({ error: 'The defect image could not be constructed. Try again.' })
              return
            }
          }
          const outputBuffer = Buffer.from(outputBase64, 'base64')
          let distinctFromPrevious = true
          for (const previousBuffer of acceptedImageBuffers) {
            if (!await imagesVisiblyDiffer(previousBuffer, outputBuffer)) {
              distinctFromPrevious = false
              break
            }
          }
          if (!distinctFromPrevious) continue
          acceptedImageBuffers.push(outputBuffer)
          results.push({
            name: `Variation ${String(results.length + 1).padStart(2, '0')}`,
            dataUrl: `data:image/png;base64,${outputBase64}`,
          })
        }
        if (results.length === previousCount) {
          response.status(422).json({ error: 'Stability AI did not return usable images for this batch. Try adjusting the prompt.' })
          return
        }
      }

      if (results.length === 0) {
        response.status(422).json({ error: 'Stability AI did not return any usable images. Try adjusting the prompt.' })
        return
      }
      response.json({
        images: results,
        positivePrompt: prompt,
        negativePrompt,
        generation: {
          provider: 'Stability AI',
          model: 'stable-diffusion-xl-1024-v1-0',
          imageStrength,
          uiImageStrength: uiStrength,
          requestedVariations: variations,
          actualVariations: results.length,
          fabricType,
          defectType: ['dataset-builder', 'defect-creation'].includes(taskMode) ? defectType : null,
          sourceImage: {
            name: request.file.originalname,
            type: request.file.mimetype,
            size: request.file.size,
          },
        },
      })
    } catch (error) {
      console.error('Stable Diffusion image-to-image request failed:', error)
      response.status(500).json({ error: 'The generation server encountered an unexpected error.' })
    }
  })
})

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'API endpoint not found.' })
})

if (fs.existsSync(path.join(frontendDist, 'index.html'))) {
  app.use(express.static(frontendDist))
  app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(frontendDist, 'index.html'))
  })
} else {
  app.get('/', (_request, response) => {
    response.send('Frontend has not been built yet. Run `npm run build` first.')
  })
}

app.use((error, _request, response, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    response.status(400).json({ error: 'Invalid JSON request payload.' })
    return
  }
  next(error)
})

app.listen(port, () => {
  console.log(`WeaveAugment server listening on port ${port}`)
})
