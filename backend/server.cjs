const express = require('express')
const multer = require('multer')
const dotenv = require('dotenv')
const fs = require('node:fs')
const path = require('node:path')

dotenv.config({ path: path.join(__dirname, '.env') })

const app = express()
const port = Number(process.env.PORT) || 3001
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist')
const maxImageBytes = 15 * 1024 * 1024
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
  if (status === 429) return 'Stability AI rate limit reached. Wait briefly and try again.'
  if (status === 413) return 'The uploaded image or request is too large for Stability AI.'
  if (status === 400 || status === 422) return `Stability AI could not process this request${detail ? `: ${detail}` : '.'}`
  if (status === 404) return `The documented SDXL image-to-image service is unavailable for this account or engine${detail ? `: ${detail}` : '.'}`
  return `Stability AI returned an error (${status})${detail ? `: ${detail}` : '.'}`
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
        response.status(503).json({ error: 'Stability AI is not configured. Add STABILITY_API_KEY=your_key to backend/.env and restart the server.' })
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

      const prompt = typeof request.body.prompt === 'string' ? request.body.prompt.trim() : ''
      const negativePrompt = typeof request.body.negativePrompt === 'string' ? request.body.negativePrompt.trim() : ''
      const imageStrength = Number(request.body.imageStrength)
      const variations = Number(request.body.variations)
      if (!prompt || prompt.length > 2000) {
        response.status(400).json({ error: 'A positive prompt of 1 to 2000 characters is required.' })
        return
      }
      if (negativePrompt.length > 2000) {
        response.status(400).json({ error: 'The negative prompt must be 2000 characters or fewer.' })
        return
      }
      if (!Number.isFinite(imageStrength) || imageStrength < 0 || imageStrength > 1) {
        response.status(400).json({ error: 'Image strength must be a number from 0 to 1.' })
        return
      }
      if (!Number.isInteger(variations) || variations < 1 || variations > 50) {
        response.status(400).json({ error: 'Requested variations must be a whole number from 1 to 50.' })
        return
      }

      const results = []
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
          results.push({
            name: `Variation ${String(results.length + 1).padStart(2, '0')}`,
            dataUrl: `data:image/png;base64,${artifact.base64}`,
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
      response.json({ images: results })
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
}

app.listen(port, () => {
  console.log(`WeaveAugment server listening on port ${port}`)
})
