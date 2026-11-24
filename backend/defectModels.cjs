const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const sharp = require('sharp')

const imageWidth = 2446
const imageHeight = 1000
const modelInputSize = 1024
const classNames = [
  'hole', 'stain', 'three-silk', 'knot', 'flower-board-skip',
  'hundred-feet', 'hairball', 'coarse-warp', 'loose-warp', 'broken-warp',
  'hanging-warp', 'coarse-weft', 'weft-shrink', 'starch-spot', 'warping-knot',
  'star-skip', 'broken-spandex', 'density-band', 'abrasion-mark', 'misc-weave',
]
const modelPaths = {
  detection: path.join(__dirname, 'models', 'fabric-defect-detection.onnx'),
  removal: path.join(__dirname, 'models', 'inpainting-lama.onnx'),
}
const minimumModelBytes = 10 * 1024 * 1024
const maxImagePixels = 24_000_000
const confidenceThreshold = 0.05
const detectionCache = new Map()
const detectionCacheLifetime = 10 * 60 * 1000
const maxCachedImages = 50

let detectionSessionPromise
let removalSessionPromise

class ModelUnavailableError extends Error {}
class InvalidImageError extends Error {}

async function modelFileAvailable(modelPath) {
  try {
    const stat = await fs.stat(modelPath)
    return stat.isFile() && stat.size >= minimumModelBytes
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function modelStatus() {
  const [defectDetectionConfigured, defectRemovalConfigured] = await Promise.all([
    modelFileAvailable(modelPaths.detection),
    modelFileAvailable(modelPaths.removal),
  ])
  return {
    defectDetectionConfigured,
    defectRemovalConfigured: defectDetectionConfigured && defectRemovalConfigured,
  }
}

async function loadModel(modelPath, name, promise) {
  if (promise) return promise
  const loading = (async () => {
    if (!await modelFileAvailable(modelPath)) {
      throw new ModelUnavailableError(`The ${name} model is missing. Run npm run models:download --workspace=weaveaugment-ai-backend and restart the backend.`)
    }
    const { InferenceSession } = require('onnxruntime-node')
    return InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: 2,
      interOpNumThreads: 1,
    })
  })()
  if (modelPath === modelPaths.detection) detectionSessionPromise = loading
  else removalSessionPromise = loading
  try {
    return await loading
  } catch (error) {
    if (modelPath === modelPaths.detection) detectionSessionPromise = null
    else removalSessionPromise = null
    throw error
  }
}

function getDetectionSession() {
  return loadModel(modelPaths.detection, 'fabric defect detection', detectionSessionPromise)
}

function getRemovalSession() {
  return loadModel(modelPaths.removal, 'LaMa inpainting', removalSessionPromise)
}

async function decodeImage(buffer) {
  try {
    const decoded = await sharp(buffer, { limitInputPixels: maxImagePixels })
      .rotate()
      .flatten({ background: { r: 114, g: 114, b: 114 } })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (decoded.info.channels !== 3 || decoded.info.width < 1 || decoded.info.height < 1) {
      throw new InvalidImageError('The uploaded image could not be decoded.')
    }
    return { rgb: decoded.data, width: decoded.info.width, height: decoded.info.height }
  } catch (error) {
    if (error instanceof InvalidImageError) throw error
    if (error instanceof Error && error.message.includes('pixel limit')) {
      throw new InvalidImageError('The image dimensions are too large to process. Choose an image under 24 megapixels.')
    }
    throw new InvalidImageError('The uploaded image could not be decoded. Please try a different PNG or JPEG.')
  }
}

async function prepareDetectorImage(buffer) {
  const decoded = await decodeImage(buffer)
  const scale = Math.min(imageWidth / decoded.width, imageHeight / decoded.height)
  const resizedWidth = Math.max(1, Math.round(decoded.width * scale))
  const resizedHeight = Math.max(1, Math.round(decoded.height * scale))
  const offsetX = Math.floor((imageWidth - resizedWidth) / 2)
  const offsetY = Math.floor((imageHeight - resizedHeight) / 2)
  const resized = await sharp(decoded.rgb, {
    raw: { width: decoded.width, height: decoded.height, channels: 3 },
  }).resize(resizedWidth, resizedHeight, { fit: 'fill' }).raw().toBuffer()
  const rgb = Buffer.alloc(imageWidth * imageHeight * 3, 114)
  for (let y = 0; y < resizedHeight; y += 1) {
    const sourceStart = y * resizedWidth * 3
    const targetStart = ((y + offsetY) * imageWidth + offsetX) * 3
    resized.copy(rgb, targetStart, sourceStart, sourceStart + resizedWidth * 3)
  }
  return {
    ...decoded,
    rgb,
    scaleX: resizedWidth / decoded.width,
    scaleY: resizedHeight / decoded.height,
    offsetX,
    offsetY,
  }
}

function imageTensor(rgb) {
  const pixels = modelInputSize * modelInputSize
  const data = new Float32Array(pixels * 3)
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const inputOffset = pixel * 3
    data[pixel] = rgb[inputOffset] / 255
    data[pixels + pixel] = rgb[inputOffset + 1] / 255
    data[pixels * 2 + pixel] = rgb[inputOffset + 2] / 255
  }
  const { Tensor } = require('onnxruntime-node')
  return new Tensor('float32', data, [1, 3, modelInputSize, modelInputSize])
}

function intersectionOverUnion(left, right) {
  const x1 = Math.max(left.x1, right.x1)
  const y1 = Math.max(left.y1, right.y1)
  const x2 = Math.min(left.x2, right.x2)
  const y2 = Math.min(left.y2, right.y2)
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const areaLeft = Math.max(0, left.x2 - left.x1) * Math.max(0, left.y2 - left.y1)
  const areaRight = Math.max(0, right.x2 - right.x1) * Math.max(0, right.y2 - right.y1)
  const union = areaLeft + areaRight - intersection
  return union > 0 ? intersection / union : 0
}

function decodeView(output, view) {
  const [batch, channels, anchors] = output.dims
  if (batch !== 1 || channels !== 24 || !Number.isInteger(anchors)) {
    throw new Error(`The fabric model returned an unsupported output shape: ${output.dims.join('×')}.`)
  }
  const values = output.data
  const candidates = []
  for (let anchor = 0; anchor < anchors; anchor += 1) {
    let classIndex = 0
    let confidence = values[4 * anchors + anchor]
    for (let classId = 1; classId < classNames.length; classId += 1) {
      const score = values[(4 + classId) * anchors + anchor]
      if (score > confidence) {
        confidence = score
        classIndex = classId
      }
    }
    if (!Number.isFinite(confidence) || confidence < confidenceThreshold) continue
    const centerX = values[anchor]
    const centerY = values[anchors + anchor]
    const width = values[2 * anchors + anchor]
    const height = values[3 * anchors + anchor]
    if (![centerX, centerY, width, height].every(Number.isFinite) || width < 1 || height < 1) continue
    candidates.push({
      x1: centerX - width / 2,
      y1: centerY - height / 2,
      x2: centerX + width / 2,
      y2: centerY + height / 2,
      classId: classIndex,
      confidence,
    })
  }

  const kept = []
  candidates.sort((left, right) => right.confidence - left.confidence)
  for (const candidate of candidates) {
    if (kept.some((accepted) => accepted.classId === candidate.classId && intersectionOverUnion(candidate, accepted) > 0.65)) continue
    kept.push(candidate)
    if (kept.length >= 300) break
  }
  return kept.map((box) => {
    if (view.type === 'strip') {
      return {
        ...box,
        x1: box.x1 / 1.024 + view.x,
        x2: box.x2 / 1.024 + view.x,
        y1: box.y1 / 1.024,
        y2: box.y2 / 1.024,
      }
    }
    const scale = modelInputSize / 1632
    const topPadding = Math.floor((modelInputSize - Math.round(667 * scale)) / 2)
    return {
      ...box,
      x1: box.x1 / modelInputSize * imageWidth,
      x2: box.x2 / modelInputSize * imageWidth,
      y1: (box.y1 - topPadding) / Math.round(667 * (modelInputSize / 1632)) * imageHeight,
      y2: (box.y2 - topPadding) / Math.round(667 * (modelInputSize / 1632)) * imageHeight,
    }
  }).map((box) => ({
    ...box,
    x1: Math.max(0, Math.min(imageWidth, box.x1)),
    y1: Math.max(0, Math.min(imageHeight, box.y1)),
    x2: Math.max(0, Math.min(imageWidth, box.x2)),
    y2: Math.max(0, Math.min(imageHeight, box.y2)),
  })).filter((box) => box.x2 - box.x1 >= 1 && box.y2 - box.y1 >= 1)
}

async function makeDetectorViews(rgb) {
  const views = []
  for (const x of [0, 723, 1446]) {
    const pixels = await sharp(rgb, {
      raw: { width: imageWidth, height: imageHeight, channels: 3 },
    }).extract({ left: x, top: 0, width: 1000, height: imageHeight })
      .resize(modelInputSize, modelInputSize)
      .raw()
      .toBuffer()
    views.push({ type: 'strip', x, pixels })
  }
  const pixels = await sharp(rgb, {
    raw: { width: imageWidth, height: imageHeight, channels: 3 },
  }).resize(1632, 667)
    .resize(1024, 418)
    .extend({ top: 303, bottom: 303, left: 0, right: 0, background: { r: 114, g: 114, b: 114 } })
    .raw()
    .toBuffer()
  views.push({ type: 'global', pixels })
  return views
}

function discardSeamBoxes(boxes, x) {
  if (x === undefined) return boxes
  const leftIsSeam = x > 0
  const rightIsSeam = x + 1000 < imageWidth
  return boxes.filter((box) =>
    !(leftIsSeam && box.x1 <= x + 3) &&
    !(rightIsSeam && box.x2 >= x + 997))
}

function fuseDetections(boxes) {
  const fused = []
  const labels = new Set(boxes.map((box) => box.classId))
  for (const classId of labels) {
    const sorted = boxes.filter((box) => box.classId === classId)
      .sort((left, right) => right.confidence - left.confidence)
    const clusters = []
    for (const box of sorted) {
      let best = -1
      let bestIou = 0.55
      for (let i = 0; i < clusters.length; i += 1) {
        const cluster = clusters[i]
        const totalWeight = cluster.boxes.reduce((sum, item) => sum + item.confidence, 0)
        const averaged = { x1: 0, y1: 0, x2: 0, y2: 0 }
        for (const item of cluster.boxes) {
          averaged.x1 += item.x1 * item.confidence / totalWeight
          averaged.y1 += item.y1 * item.confidence / totalWeight
          averaged.x2 += item.x2 * item.confidence / totalWeight
          averaged.y2 += item.y2 * item.confidence / totalWeight
        }
        const overlap = intersectionOverUnion(box, averaged)
        if (overlap >= bestIou) {
          best = i
          bestIou = overlap
        }
      }
      if (best < 0) clusters.push({ boxes: [box] })
      else clusters[best].boxes.push(box)
    }
    for (const cluster of clusters) {
      const totalWeight = cluster.boxes.reduce((sum, item) => sum + item.confidence, 0)
      const box = { x1: 0, y1: 0, x2: 0, y2: 0 }
      for (const item of cluster.boxes) {
        box.x1 += item.x1 * item.confidence / totalWeight
        box.y1 += item.y1 * item.confidence / totalWeight
        box.x2 += item.x2 * item.confidence / totalWeight
        box.y2 += item.y2 * item.confidence / totalWeight
      }
      const meanConfidence = cluster.boxes.reduce((sum, item) => sum + item.confidence, 0) / cluster.boxes.length
      const confidence = meanConfidence * Math.min(cluster.boxes.length, 4) / 4
      if (confidence >= confidenceThreshold) fused.push({ ...box, classId, confidence })
    }
  }
  return fused.sort((left, right) => right.confidence - left.confidence)
}

async function detectDefects(buffer) {
  const [prepared, session] = await Promise.all([prepareDetectorImage(buffer), getDetectionSession()])
  const views = await makeDetectorViews(prepared.rgb)
  const boxes = []
  for (const view of views) {
    const result = await session.run({ [session.inputNames[0]]: imageTensor(view.pixels) })
    const decoded = decodeView(result[session.outputNames[0]], view)
    boxes.push(...discardSeamBoxes(decoded, view.type === 'strip' ? view.x : undefined))
  }
  const detections = fuseDetections(boxes).map((box, index) => {
    const x = Math.max(0, (box.x1 - prepared.offsetX) / prepared.scaleX)
    const y = Math.max(0, (box.y1 - prepared.offsetY) / prepared.scaleY)
    const right = Math.min(prepared.width, (box.x2 - prepared.offsetX) / prepared.scaleX)
    const bottom = Math.min(prepared.height, (box.y2 - prepared.offsetY) / prepared.scaleY)
    return {
      id: `defect-${index + 1}`,
      label: classNames[box.classId],
      confidence: box.confidence,
      bbox: {
        x,
        y,
        width: Math.max(0, right - x),
        height: Math.max(0, bottom - y),
      },
    }
  }).filter((detection) => detection.bbox.width > 0 && detection.bbox.height > 0)
  return { detections, imageWidth: prepared.width, imageHeight: prepared.height }
}

function cacheKey(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function cacheDetections(buffer, result) {
  const key = cacheKey(buffer)
  detectionCache.delete(key)
  detectionCache.set(key, { result, createdAt: Date.now() })
  for (const [cachedKey, entry] of detectionCache) {
    if (Date.now() - entry.createdAt > detectionCacheLifetime) detectionCache.delete(cachedKey)
  }
  while (detectionCache.size > maxCachedImages) detectionCache.delete(detectionCache.keys().next().value)
}

function getCachedDetections(buffer) {
  const key = cacheKey(buffer)
  const entry = detectionCache.get(key)
  if (!entry || Date.now() - entry.createdAt > detectionCacheLifetime) {
    detectionCache.delete(key)
    return null
  }
  detectionCache.delete(key)
  detectionCache.set(key, entry)
  return entry.result
}

function grayTensor(mask) {
  const data = new Float32Array(mask.length)
  for (let i = 0; i < mask.length; i += 1) data[i] = mask[i] > 0 ? 1 : 0
  const { Tensor } = require('onnxruntime-node')
  return new Tensor('float32', data, [1, 1, 512, 512])
}

function colorTensor(rgb) {
  const pixels = 512 * 512
  const data = new Float32Array(pixels * 3)
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 3
    data[pixel] = rgb[offset + 2] / 255
    data[pixels + pixel] = rgb[offset + 1] / 255
    data[pixels * 2 + pixel] = rgb[offset] / 255
  }
  const { Tensor } = require('onnxruntime-node')
  return new Tensor('float32', data, [1, 3, 512, 512])
}

function insertRows(destination, source, width, height, channels, left, top) {
  for (let y = 0; y < height; y += 1) {
    const start = y * width * channels
    const targetStart = ((y + top) * 512 + left) * channels
    destination.set(source.subarray(start, start + width * channels), targetStart)
  }
}

function findCrop(box, width, height) {
  const boxWidth = Math.max(1, box.bbox.width)
  const boxHeight = Math.max(1, box.bbox.height)
  const cropWidth = Math.min(width, Math.max(Math.min(512, width), Math.ceil(boxWidth * 1.4)))
  const cropHeight = Math.min(height, Math.max(Math.min(512, height), Math.ceil(boxHeight * 1.4)))
  const centerX = box.bbox.x + boxWidth / 2
  const centerY = box.bbox.y + boxHeight / 2
  const left = Math.max(0, Math.min(width - cropWidth, Math.floor(centerX - cropWidth / 2)))
  const top = Math.max(0, Math.min(height - cropHeight, Math.floor(centerY - cropHeight / 2)))
  return { left, top, width: cropWidth, height: cropHeight }
}

async function inpaintDefects(buffer, selectedIds) {
  const originalDetections = getCachedDetections(buffer) || await detectDefects(buffer)
  if (!getCachedDetections(buffer)) cacheDetections(buffer, originalDetections)
  const requested = new Set(selectedIds)
  const selected = originalDetections.detections.filter((detection) => requested.has(detection.id))
  if (!selected.length || selected.length !== requested.size) {
    throw new InvalidImageError('The selected defects do not match this uploaded image. Analyze this image again and reselect defects.')
  }

  const decoded = await decodeImage(buffer)
  let working = Buffer.from(decoded.rgb)
  const session = await getRemovalSession()
  for (const detection of selected) {
    const crop = findCrop(detection, decoded.width, decoded.height)
    const cropped = await sharp(working, {
      raw: { width: decoded.width, height: decoded.height, channels: 3 },
    }).extract(crop).raw().toBuffer()
    const scale = Math.min(512 / crop.width, 512 / crop.height)
    const resizedWidth = Math.max(1, Math.round(crop.width * scale))
    const resizedHeight = Math.max(1, Math.round(crop.height * scale))
    const padLeft = Math.floor((512 - resizedWidth) / 2)
    const padTop = Math.floor((512 - resizedHeight) / 2)
    const resizedImage = await sharp(cropped, {
      raw: { width: crop.width, height: crop.height, channels: 3 },
    }).resize(resizedWidth, resizedHeight, { fit: 'fill' }).raw().toBuffer()
    const imageInput = new Uint8Array(512 * 512 * 3).fill(114)
    insertRows(imageInput, resizedImage, resizedWidth, resizedHeight, 3, padLeft, padTop)

    const mask = new Uint8Array(crop.width * crop.height)
    const paddingX = Math.max(6, detection.bbox.width * 0.18)
    const paddingY = Math.max(6, detection.bbox.height * 0.18)
    const maskLeft = Math.max(0, Math.floor(detection.bbox.x - paddingX - crop.left))
    const maskTop = Math.max(0, Math.floor(detection.bbox.y - paddingY - crop.top))
    const maskRight = Math.min(crop.width, Math.ceil(detection.bbox.x + detection.bbox.width + paddingX - crop.left))
    const maskBottom = Math.min(crop.height, Math.ceil(detection.bbox.y + detection.bbox.height + paddingY - crop.top))
    for (let y = maskTop; y < maskBottom; y += 1) mask.fill(255, y * crop.width + maskLeft, y * crop.width + maskRight)

    const resizedMask = await sharp(mask, {
      raw: { width: crop.width, height: crop.height, channels: 1 },
    }).resize(resizedWidth, resizedHeight, { kernel: sharp.kernel.nearest }).raw().toBuffer()
    const maskInput = new Uint8Array(512 * 512)
    insertRows(maskInput, resizedMask, resizedWidth, resizedHeight, 1, padLeft, padTop)
    const output = await session.run({
      image: colorTensor(imageInput),
      mask: grayTensor(maskInput),
    })
    const result = output[session.outputNames[0]]
    if (result.dims.length !== 4 || result.dims[1] !== 3 || result.dims[2] !== 512 || result.dims[3] !== 512) {
      throw new Error(`LaMa returned an unsupported output shape: ${result.dims.join('×')}.`)
    }
    const restored = new Uint8Array(512 * 512 * 3)
    const channelSize = 512 * 512
    for (let pixel = 0; pixel < channelSize; pixel += 1) {
      restored[pixel * 3] = Math.max(0, Math.min(255, Math.round(result.data[2 * channelSize + pixel])))
      restored[pixel * 3 + 1] = Math.max(0, Math.min(255, Math.round(result.data[channelSize + pixel])))
      restored[pixel * 3 + 2] = Math.max(0, Math.min(255, Math.round(result.data[pixel])))
    }
    const restoredCrop = await sharp(restored, {
      raw: { width: 512, height: 512, channels: 3 },
    }).extract({ left: padLeft, top: padTop, width: resizedWidth, height: resizedHeight })
      .resize(crop.width, crop.height, { fit: 'fill' }).raw().toBuffer()
    const feather = await sharp(mask, {
      raw: { width: crop.width, height: crop.height, channels: 1 },
    }).blur(2).raw().toBuffer()
    for (let y = 0; y < crop.height; y += 1) {
      for (let x = 0; x < crop.width; x += 1) {
        const alpha = feather[y * crop.width + x] / 255
        if (alpha <= 0) continue
        const source = (y * crop.width + x) * 3
        const target = ((y + crop.top) * decoded.width + x + crop.left) * 3
        for (let channel = 0; channel < 3; channel += 1) {
          working[target + channel] = Math.round(working[target + channel] * (1 - alpha) + restoredCrop[source + channel] * alpha)
        }
      }
    }
  }
  const png = await sharp(working, {
    raw: { width: decoded.width, height: decoded.height, channels: 3 },
  }).png().toBuffer()
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, removedCount: selected.length }
}

module.exports = {
  InvalidImageError,
  ModelUnavailableError,
  cacheDetections,
  detectDefects,
  inpaintDefects,
  modelStatus,
}
